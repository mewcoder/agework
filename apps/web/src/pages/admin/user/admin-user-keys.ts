/** admin 用户列表 react-query 键的唯一 factory:列表页与新建弹窗共用,不再各写一遍数组字面量。 */
export const adminUserKeys = {
  all: ["admin", "users"] as const,
  list: (pageNo: number) => ["admin", "users", pageNo] as const,
};
