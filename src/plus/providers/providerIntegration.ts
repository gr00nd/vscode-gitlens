import type { AuthenticationSession, AuthenticationSessionsChangeEvent, Event, MessageItem } from 'vscode';
import { authentication, EventEmitter, window } from 'vscode';
import { wrapForForcedInsecureSSL } from '@env/fetch';
import { isWeb } from '@env/platform';
import type { Container } from '../../container';
import { AuthenticationError, ProviderRequestClientError } from '../../errors';
import type { Account } from '../../git/models/author';
import type { DefaultBranch } from '../../git/models/defaultBranch';
import type { IssueOrPullRequest, SearchedIssue } from '../../git/models/issue';
import type { PullRequest, PullRequestState, SearchedPullRequest } from '../../git/models/pullRequest';
import type { RepositoryMetadata } from '../../git/models/repositoryMetadata';
import { showIntegrationDisconnectedTooManyFailedRequestsWarningMessage } from '../../messages';
import { isSubscriptionPaidPlan, isSubscriptionPreviewTrialExpired } from '../../subscription';
import { configuration } from '../../system/configuration';
import { gate } from '../../system/decorators/gate';
import { debug, log } from '../../system/decorators/log';
import { Logger } from '../../system/logger';
import { getLogScope } from '../../system/logger.scope';
import { isPromise } from '../../system/promise';
import type {
	IntegrationAuthenticationProviderDescriptor,
	IntegrationAuthenticationSessionDescriptor,
} from '../integrationAuthentication';

// TODO@eamodio revisit how once authenticated, all remotes are always connected, even after a restart

export type SupportedProviderIds = 'github' | 'github-enterprise';
export type ProviderKey = `${SupportedProviderIds}|${string}`;

export type RepositoryDescriptor = Record<string, unknown>;

export abstract class ProviderIntegration<T extends RepositoryDescriptor = RepositoryDescriptor> {
	private readonly _onDidChange = new EventEmitter<void>();
	get onDidChange(): Event<void> {
		return this._onDidChange.event;
	}

	constructor(protected readonly container: Container) {
		container.context.subscriptions.push(
			configuration.onDidChange(e => {
				if (configuration.changed(e, 'remotes')) {
					this._ignoreSSLErrors.clear();
				}
			}),
			// TODO@eamodio revisit how connections are linked or not
			container.richRemoteProviders.onDidChangeConnectionState(e => {
				if (e.key !== this.key) return;

				if (e.reason === 'disconnected') {
					void this.disconnect({ silent: true });
				} else if (e.reason === 'connected') {
					void this.ensureSession(false);
				}
			}),
			authentication.onDidChangeSessions(this.onAuthenticationSessionsChanged, this),
		);
	}

	abstract get authProvider(): IntegrationAuthenticationProviderDescriptor;
	abstract get id(): SupportedProviderIds;
	abstract get name(): string;
	abstract get domain(): string;

	protected get authProviderDescriptor(): IntegrationAuthenticationSessionDescriptor {
		return { domain: this.domain, scopes: this.authProvider.scopes };
	}

	get icon(): string {
		return this.id;
	}

	protected get key(): `${SupportedProviderIds}` | `${SupportedProviderIds}:${string}` {
		return this.id;
	}

	private get connectedKey(): `connected:${ProviderIntegration['key']}` {
		return `connected:${this.key}`;
	}

	get maybeConnected(): boolean | undefined {
		return this._session === undefined ? undefined : this._session !== null;
	}

	protected _session: AuthenticationSession | null | undefined;
	protected session() {
		if (this._session === undefined) {
			return this.ensureSession(false);
		}
		return this._session ?? undefined;
	}

	private onAuthenticationSessionsChanged(e: AuthenticationSessionsChangeEvent) {
		if (e.provider.id === this.authProvider.id) {
			void this.ensureSession(false);
		}
	}

	@log()
	async connect(): Promise<boolean> {
		try {
			const session = await this.ensureSession(true);
			return Boolean(session);
		} catch (ex) {
			return false;
		}
	}

	@gate()
	@log()
	async disconnect(options?: { silent?: boolean; currentSessionOnly?: boolean }): Promise<void> {
		if (options?.currentSessionOnly && this._session === null) return;

		const connected = this._session != null;

		if (connected && !options?.silent) {
			if (options?.currentSessionOnly) {
				void showIntegrationDisconnectedTooManyFailedRequestsWarningMessage(this.name);
			} else {
				const disable = { title: 'Disable' };
				const signout = { title: 'Disable & Sign Out' };
				const cancel = { title: 'Cancel', isCloseAffordance: true };

				let result: MessageItem | undefined;
				if (this.container.integrationAuthentication.hasProvider(this.authProvider.id)) {
					result = await window.showWarningMessage(
						`Are you sure you want to disable the rich integration with ${this.name}?\n\nNote: signing out clears the saved authentication.`,
						{ modal: true },
						disable,
						signout,
						cancel,
					);
				} else {
					result = await window.showWarningMessage(
						`Are you sure you want to disable the rich integration with ${this.name}?`,
						{ modal: true },
						disable,
						cancel,
					);
				}

				if (result == null || result === cancel) return;
				if (result === signout) {
					void this.container.integrationAuthentication.deleteSession(
						this.authProvider.id,
						this.authProviderDescriptor,
					);
				}
			}
		}

		this.resetRequestExceptionCount();
		this._repoMetadata = undefined;
		this._prsByCommit.clear();
		this._session = null;

		if (connected) {
			// Don't store the disconnected flag if this only for this current VS Code session (will be re-connected on next restart)
			if (!options?.currentSessionOnly) {
				void this.container.storage.storeWorkspace(this.connectedKey, false);
			}

			this._onDidChange.fire();
			if (!options?.silent && !options?.currentSessionOnly) {
				this.container.richRemoteProviders.disconnected(this.key);
			}
		}
	}

	@log()
	async reauthenticate(): Promise<void> {
		if (this._session === undefined) return;

		this._session = undefined;
		void (await this.ensureSession(true, true));
	}

	private requestExceptionCount = 0;

	resetRequestExceptionCount(): void {
		this.requestExceptionCount = 0;
	}

	@debug()
	trackRequestException(): void {
		this.requestExceptionCount++;

		if (this.requestExceptionCount >= 5 && this._session !== null) {
			void this.disconnect({ currentSessionOnly: true });
		}
	}

	@gate()
	@debug({ exit: true })
	async isConnected(): Promise<boolean> {
		return (await this.session()) != null;
	}

	@gate()
	@debug()
	async getAccountForCommit(
		repo: T,
		ref: string,
		options?: {
			avatarSize?: number;
		},
	): Promise<Account | undefined> {
		const scope = getLogScope();

		const connected = this.maybeConnected ?? (await this.isConnected());
		if (!connected) return undefined;

		try {
			const author = await this.getProviderAccountForCommit(this._session!, repo, ref, options);
			this.resetRequestExceptionCount();
			return author;
		} catch (ex) {
			Logger.error(ex, scope);

			if (ex instanceof AuthenticationError || ex instanceof ProviderRequestClientError) {
				this.trackRequestException();
			}
			return undefined;
		}
	}

	protected abstract getProviderAccountForCommit(
		session: AuthenticationSession,
		repo: T,
		ref: string,
		options?: {
			avatarSize?: number;
		},
	): Promise<Account | undefined>;

	@gate()
	@debug()
	async getAccountForEmail(
		repo: T,
		email: string,
		options?: {
			avatarSize?: number;
		},
	): Promise<Account | undefined> {
		const scope = getLogScope();

		const connected = this.maybeConnected ?? (await this.isConnected());
		if (!connected) return undefined;

		try {
			const author = await this.getProviderAccountForEmail(this._session!, repo, email, options);
			this.resetRequestExceptionCount();
			return author;
		} catch (ex) {
			Logger.error(ex, scope);

			if (ex instanceof AuthenticationError || ex instanceof ProviderRequestClientError) {
				this.trackRequestException();
			}
			return undefined;
		}
	}

	protected abstract getProviderAccountForEmail(
		session: AuthenticationSession,
		repo: T,
		email: string,
		options?: {
			avatarSize?: number;
		},
	): Promise<Account | undefined>;

	@gate()
	@debug()
	async getDefaultBranch(repo: T): Promise<DefaultBranch | undefined> {
		const scope = getLogScope();

		const connected = this.maybeConnected ?? (await this.isConnected());
		if (!connected) return undefined;

		try {
			const defaultBranch = await this.getProviderDefaultBranch(this._session!, repo);
			this.resetRequestExceptionCount();
			return defaultBranch;
		} catch (ex) {
			Logger.error(ex, scope);

			if (ex instanceof AuthenticationError || ex instanceof ProviderRequestClientError) {
				this.trackRequestException();
			}
			return undefined;
		}
	}

	protected abstract getProviderDefaultBranch(
		{ accessToken }: AuthenticationSession,
		repo: T,
	): Promise<DefaultBranch | undefined>;

	private _repoMetadata: RepositoryMetadata | undefined;

	@gate()
	@debug()
	async getRepositoryMetadata(repo: T): Promise<RepositoryMetadata | undefined> {
		if (this._repoMetadata != null) return this._repoMetadata;

		const scope = getLogScope();

		const connected = this.maybeConnected ?? (await this.isConnected());
		if (!connected) return undefined;

		try {
			const metadata = await this.getProviderRepositoryMetadata(this._session!, repo);
			this._repoMetadata = metadata;
			this.resetRequestExceptionCount();
			return metadata;
		} catch (ex) {
			Logger.error(ex, scope);

			if (ex instanceof AuthenticationError || ex instanceof ProviderRequestClientError) {
				this.trackRequestException();
			}
			return undefined;
		}
	}

	protected abstract getProviderRepositoryMetadata(
		{ accessToken }: AuthenticationSession,
		repo: T,
	): Promise<RepositoryMetadata | undefined>;

	@gate()
	@debug()
	async searchMyPullRequests(): Promise<SearchedPullRequest[] | undefined> {
		const scope = getLogScope();

		try {
			const pullRequests = await this.searchProviderMyPullRequests(this._session!);
			this.resetRequestExceptionCount();
			return pullRequests;
		} catch (ex) {
			Logger.error(ex, scope);

			if (ex instanceof AuthenticationError || ex instanceof ProviderRequestClientError) {
				this.trackRequestException();
			}
			return undefined;
		}
	}
	protected abstract searchProviderMyPullRequests(
		session: AuthenticationSession,
	): Promise<SearchedPullRequest[] | undefined>;

	@gate()
	@debug()
	async searchMyIssues(): Promise<SearchedIssue[] | undefined> {
		const scope = getLogScope();

		try {
			const issues = await this.searchProviderMyIssues(this._session!);
			this.resetRequestExceptionCount();
			return issues;
		} catch (ex) {
			Logger.error(ex, scope);

			if (ex instanceof AuthenticationError || ex instanceof ProviderRequestClientError) {
				this.trackRequestException();
			}
			return undefined;
		}
	}
	protected abstract searchProviderMyIssues(session: AuthenticationSession): Promise<SearchedIssue[] | undefined>;

	@gate()
	@debug()
	async getIssueOrPullRequest(repo: T, id: string): Promise<IssueOrPullRequest | undefined> {
		const scope = getLogScope();

		const connected = this.maybeConnected ?? (await this.isConnected());
		if (!connected) return undefined;

		try {
			const issueOrPullRequest = await this.getProviderIssueOrPullRequest(this._session!, repo, id);
			this.resetRequestExceptionCount();
			return issueOrPullRequest;
		} catch (ex) {
			Logger.error(ex, scope);

			if (ex instanceof AuthenticationError || ex instanceof ProviderRequestClientError) {
				this.trackRequestException();
			}
			return undefined;
		}
	}

	protected abstract getProviderIssueOrPullRequest(
		session: AuthenticationSession,
		repo: T,
		id: string,
	): Promise<IssueOrPullRequest | undefined>;

	@gate()
	@debug()
	async getPullRequestForBranch(
		repo: T,
		branch: string,
		options?: {
			avatarSize?: number;
			include?: PullRequestState[];
		},
	): Promise<PullRequest | undefined> {
		const scope = getLogScope();

		const connected = this.maybeConnected ?? (await this.isConnected());
		if (!connected) return undefined;

		try {
			const pr = await this.getProviderPullRequestForBranch(this._session!, repo, branch, options);
			this.resetRequestExceptionCount();
			return pr;
		} catch (ex) {
			Logger.error(ex, scope);

			if (ex instanceof AuthenticationError || ex instanceof ProviderRequestClientError) {
				this.trackRequestException();
			}
			return undefined;
		}
	}
	protected abstract getProviderPullRequestForBranch(
		session: AuthenticationSession,
		repo: T,
		branch: string,
		options?: {
			avatarSize?: number;
			include?: PullRequestState[];
		},
	): Promise<PullRequest | undefined>;

	private _prsByCommit = new Map<string, Promise<PullRequest | null> | PullRequest | null>();

	@debug()
	getPullRequestForCommit(repo: T, ref: string): Promise<PullRequest | undefined> | PullRequest | undefined {
		let pr = this._prsByCommit.get(ref);
		if (pr === undefined) {
			pr = this.getPullRequestForCommitCore(repo, ref);
			this._prsByCommit.set(ref, pr);
		}
		if (pr == null || !isPromise(pr)) return pr ?? undefined;

		return pr.then(pr => pr ?? undefined);
	}

	@debug()
	private async getPullRequestForCommitCore(repo: T, ref: string) {
		const scope = getLogScope();

		const connected = this.maybeConnected ?? (await this.isConnected());
		if (!connected) return null;

		try {
			const pr = (await this.getProviderPullRequestForCommit(this._session!, repo, ref)) ?? null;
			this._prsByCommit.set(ref, pr);
			this.resetRequestExceptionCount();
			return pr;
		} catch (ex) {
			Logger.error(ex, scope);

			this._prsByCommit.delete(ref);

			if (ex instanceof AuthenticationError || ex instanceof ProviderRequestClientError) {
				this.trackRequestException();
			}
			return null;
		}
	}

	protected abstract getProviderPullRequestForCommit(
		session: AuthenticationSession,
		repo: T,
		ref: string,
	): Promise<PullRequest | undefined>;

	@gate()
	/*private*/
	async ensureSession(
		createIfNeeded: boolean,
		forceNewSession: boolean = false,
	): Promise<AuthenticationSession | undefined> {
		if (this._session != null) return this._session;
		if (!configuration.get('integrations.enabled')) return undefined;

		if (createIfNeeded) {
			await this.container.storage.deleteWorkspace(this.connectedKey);
		} else if (this.container.storage.getWorkspace(this.connectedKey) === false) {
			return undefined;
		}

		let session: AuthenticationSession | undefined | null;
		try {
			if (this.container.integrationAuthentication.hasProvider(this.authProvider.id)) {
				session = await this.container.integrationAuthentication.getSession(
					this.authProvider.id,
					this.authProviderDescriptor,
					{ createIfNeeded: createIfNeeded, forceNewSession: forceNewSession },
				);
			} else {
				session = await wrapForForcedInsecureSSL(this.getIgnoreSSLErrors(), () =>
					authentication.getSession(this.authProvider.id, this.authProvider.scopes, {
						createIfNone: forceNewSession ? undefined : createIfNeeded,
						silent: !createIfNeeded && !forceNewSession ? true : undefined,
						forceNewSession: forceNewSession ? true : undefined,
					}),
				);
			}
		} catch (ex) {
			await this.container.storage.deleteWorkspace(this.connectedKey);

			if (ex instanceof Error && ex.message.includes('User did not consent')) {
				return undefined;
			}

			session = null;
		}

		if (session === undefined && !createIfNeeded) {
			await this.container.storage.deleteWorkspace(this.connectedKey);
		}

		this._session = session ?? null;
		this.resetRequestExceptionCount();

		if (session != null) {
			await this.container.storage.storeWorkspace(this.connectedKey, true);

			queueMicrotask(() => {
				this._onDidChange.fire();
				this.container.richRemoteProviders.connected(this.key);
			});
		}

		return session ?? undefined;
	}

	private _ignoreSSLErrors = new Map<string, boolean | 'force'>();
	getIgnoreSSLErrors(): boolean | 'force' {
		if (isWeb) return false;

		let ignoreSSLErrors = this._ignoreSSLErrors.get(this.id);
		if (ignoreSSLErrors === undefined) {
			const cfg = configuration
				.get('remotes')
				?.find(remote => remote.type.toLowerCase() === this.id && remote.domain === this.domain);
			ignoreSSLErrors = cfg?.ignoreSSLErrors ?? false;
			this._ignoreSSLErrors.set(this.id, ignoreSSLErrors);
		}

		return ignoreSSLErrors;
	}
}

export async function ensurePaidPlan(providerName: string, container: Container): Promise<boolean> {
	const title = `Connecting to a ${providerName} instance for rich integration features requires a trial or paid plan.`;

	while (true) {
		const subscription = await container.subscription.getSubscription();
		if (subscription.account?.verified === false) {
			const resend = { title: 'Resend Verification' };
			const cancel = { title: 'Cancel', isCloseAffordance: true };
			const result = await window.showWarningMessage(
				`${title}\n\nYou must verify your email before you can continue.`,
				{ modal: true },
				resend,
				cancel,
			);

			if (result === resend) {
				if (await container.subscription.resendVerification()) {
					continue;
				}
			}

			return false;
		}

		const plan = subscription.plan.effective.id;
		if (isSubscriptionPaidPlan(plan)) break;

		if (subscription.account == null && !isSubscriptionPreviewTrialExpired(subscription)) {
			const startTrial = { title: 'Preview Pro' };
			const cancel = { title: 'Cancel', isCloseAffordance: true };
			const result = await window.showWarningMessage(
				`${title}\n\nDo you want to preview ✨ features for 3 days?`,
				{ modal: true },
				startTrial,
				cancel,
			);

			if (result !== startTrial) return false;

			void container.subscription.startPreviewTrial();
			break;
		} else if (subscription.account == null) {
			const signIn = { title: 'Start Free Pro Trial' };
			const cancel = { title: 'Cancel', isCloseAffordance: true };
			const result = await window.showWarningMessage(
				`${title}\n\nDo you want to continue to use ✨ features on privately hosted repos, free for an additional 7 days?`,
				{ modal: true },
				signIn,
				cancel,
			);

			if (result === signIn) {
				if (await container.subscription.loginOrSignUp()) {
					continue;
				}
			}
		} else {
			const upgrade = { title: 'Upgrade to Pro' };
			const cancel = { title: 'Cancel', isCloseAffordance: true };
			const result = await window.showWarningMessage(
				`${title}\n\nDo you want to continue to use ✨ features on privately hosted repos?`,
				{ modal: true },
				upgrade,
				cancel,
			);

			if (result === upgrade) {
				void container.subscription.purchase();
			}
		}

		return false;
	}

	return true;
}
