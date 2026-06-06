export interface MappedUser {
  id: number;
  first_name: string;
  last_name: string;
  username: string | null;
  phone: string | null;
  status: string | null;
  bio: string | null;
}

export interface MappedContact {
  id: number;
  first_name: string;
  last_name: string;
  username: string | null;
  phone: string | null;
}

function userStatus(status: Record<string, any> | null): string | null {
  if (!status) return null;
  switch (status._) {
    case "userStatusOnline":
      return "online";
    case "userStatusOffline":
      return "offline";
    case "userStatusRecently":
      return "recently";
    case "userStatusLastWeek":
      return "last_week";
    case "userStatusLastMonth":
      return "last_month";
    case "userStatusEmpty":
      return "unknown";
    default:
      return null;
  }
}

export function mapUser(
  user: Record<string, any>,
  bio?: string | null
): MappedUser {
  return {
    id: user.id,
    first_name: user.first_name || "",
    last_name: user.last_name || "",
    username: user.usernames?.active_usernames?.[0] ?? null,
    phone: user.phone_number || null,
    status: userStatus(user.status),
    bio: bio ?? null,
  };
}

export function mapContact(user: Record<string, any>): MappedContact {
  return {
    id: user.id,
    first_name: user.first_name || "",
    last_name: user.last_name || "",
    username: user.usernames?.active_usernames?.[0] ?? null,
    phone: user.phone_number || null,
  };
}
