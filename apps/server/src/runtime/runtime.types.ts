/** builtin（本机 in-process）RuntimeHost 的固定 id。所有 runtimeType 都走这一个 Host，
 *  不再有 managed-native/managed-docker/managed-opensandbox 三行假行。 */
export const BUILTIN_HOST_ID = "builtin";

/** 是否是 builtin RuntimeHost id——固定值匹配，不用查库。 */
export function isBuiltinHostId(runtimeHostId: string): boolean {
  return runtimeHostId === BUILTIN_HOST_ID;
}
