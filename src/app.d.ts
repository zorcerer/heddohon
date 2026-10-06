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
		interface PageState {
			/** The player sheet is open over this entry, on a phone; see the root layout. */
			sheet?: boolean;
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
