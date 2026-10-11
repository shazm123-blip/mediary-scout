/** Custom acquisition rules must be merged with upstream before deployment. */
export function isForkBuild(): boolean {
  return process.env.MEDIA_TRACK_FORK_BUILD === "1";
}

export const FORK_UPDATE_MESSAGE = "当前为定制版本。请先合并并验证官方更新，再部署，保留你的获取规则。";
