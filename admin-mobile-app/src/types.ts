export type AdminIdentity = {
  user_id: string;
  role: 'owner' | 'admin';
  assurance_level: 'aal1' | 'aal2';
  mfa_required: boolean;
  mfa_satisfied: boolean;
};

export type Overview = {
  users: number;
  devices: number;
  owned_devices: number;
  current_subscriptions: number;
  available_devices: number;
};

export type UserSummary = {
  id: string;
  display_name: string | null;
  email: string | null;
  created_at: string;
  tracker_count: number;
  subscription_count: number;
  is_admin: boolean;
  account_status: 'active' | 'banned';
  banned_at: string | null;
  ban_reason: string | null;
};

export type TrackerSummary = {
  id: string;
  serial_number: string;
  name: string | null;
  status: string | null;
  firmware_version: string | null;
  last_latitude: number | null;
  last_longitude: number | null;
  last_location_at: string | null;
  last_place: string | null;
  started_at: string;
};

export type AccountSubscriptionSummary = {
  id: string;
  status: string;
  plan_code: string;
  current_period_end: string;
  source: string;
};

export type UserTrackers = {
  user: Pick<UserSummary, 'id' | 'display_name' | 'email' | 'created_at' | 'account_status' | 'banned_at' | 'ban_reason'>;
  subscription: AccountSubscriptionSummary | null;
  trackers: TrackerSummary[];
};

export type Plan = {
  code: string;
  name: string;
  duration_months: 1 | 3 | 6 | 12;
  price_cents: number;
  currency: string;
  active: boolean;
  provider_price_id: string | null;
  provider_product_id: string | null;
  price_version: number;
  updated_at: string;
};

export type Audit = {
  id: string;
  actor_user_id: string;
  actor_email: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  request_id: string;
  details: Record<string, unknown>;
  created_at: string;
};

export type AdminAssignment = {
  id: string;
  user_id: string;
  email: string | null;
  display_name: string | null;
  granted_by: string;
  granted_at: string;
};

export type AdminSection = 'overview' | 'users' | 'plans' | 'more';
export type MoreRoute = 'menu' | 'register' | 'admins' | 'audit';
