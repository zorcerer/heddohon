import type { Account, AuthenticatedSession } from '$lib/server/auth';
import type { UserSettings } from '$lib/server/settings';

declare global {
	namespace App {
		interface Error {
			message: string;
			detail?: string;
		}
		interface Locals {
			session: AuthenticatedSession | null;
			settings: UserSettings | null;
		}
		interface PageData {
			account?: Account | null;
			settings?: UserSettings;
			sharing?: boolean;
			downloads?: boolean;
		}
	}
}

export {};
