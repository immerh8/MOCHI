import type { Catalogue } from "../types";
import type { common as enCommon } from "../en/common";
// Glossary (keep these terms the same in every zh-CN file):
//   archive 压缩文件 · extract 解压 · test 测试 · add 添加 · remove 移除 (from a version/list) · delete 删除
//   version 版本 · commit 提交 · snapshot 快照 · history 历史记录 · entry/item 项目 · folder 文件夹
//   passphrase 口令 (MOCHI archives) · password 密码 (other formats, e.g. ZIP/7z/RAR)
//   encrypt 加密 · key envelope 密钥信封 · data key 数据密钥 · recovery record 恢复记录 · repair 修复
//   retention 保留期限 · legal hold 法律保留 · salvage scan 抢救扫描 · coverage 覆盖范围
//   Kept in English: PASS FAIL DEGRADED UNKNOWN OVERDUE UNSUPPORTED, LOCAL_COMMITTED, error codes, format names.
//   Never used (spec 23.3 backstop): backup / safe / secure / preserved / revoke words.
// Wording shared by more than one screen.
export const common = {
  "common.cancel": "取消",
  "common.close": "关闭",
  "common.starting": "正在启动…",
  "common.loading": "正在加载…",
  "common.cancelling": "（正在取消…）",
  "common.folder": "文件夹",
  "common.file": "文件",
  "common.escapedMarker": "（已转义）",
  "common.escapedHint":
    "已转义显示：存储的名称含有控制字符、方向覆盖字符、反斜杠，或不是 UTF-8 的字节。",
  "common.errorWithCode": "{what}（{code}）：{message}",
  "common.errorPlain": "{what}。",
  "common.completed": "已完成：{summary}。",
  "common.failed": "失败（{code}）：{message}",
  "common.stoppedUnexpectedly": "意外停止：{message}",
  "common.byteOne": "{n} 字节",
  "common.bytesMany": "{n} 字节",
  "common.sizeWithExact": "{human}（{exact}）",
  "common.sizeHuman": "{value} {unit}",
  "common.progress": "进度",
  "common.itemOne": "{n} 项",
  "common.itemMany": "{n} 项",
  "common.selectedCount": "已选 {n} 项",
  "common.statusSeparator": " · ",
  "count.fileOne": "{n} 个文件",
  "count.fileMany": "{n} 个文件",
  "count.folderOne": "{n} 个文件夹",
  "count.folderMany": "{n} 个文件夹",
  "count.entryOne": "{n} 个项目",
  "count.entryMany": "{n} 个项目",
  "count.problemOne": "{n} 个问题",
  "count.problemMany": "{n} 个问题",
  "common.andMore": "…另有 {n} 项。",
} satisfies Catalogue<typeof enCommon>;
