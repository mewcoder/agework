export function isAdmin(role?: string): boolean {
  return role === 'super_admin' || role === 'admin';
}

export function roleLabel(role?: string): string {
  if (role === 'super_admin') return '超级管理员';
  if (role === 'admin') return '管理员';
  return '普通用户';
}