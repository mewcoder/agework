export type UserSession = {
  userId: string;
  username: string;
  role: string;
  status: string;
  mustChangePassword: boolean;
  sessionVersion: number;
};
