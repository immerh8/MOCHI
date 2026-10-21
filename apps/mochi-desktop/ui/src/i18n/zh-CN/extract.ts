import type { Catalogue } from "../types";
import type { extract as enExtract } from "../en/extract";
// Extraction (plan D3; spec §23.3): extracting is not a verification, so
// nothing here gets success styling.
export const extract = {
  "extract.heading": "解压",
  "extract.selectedTip": "解压所选的 {n} 项",
  "extract.toolbar": "解压",
  "extract.allTip": "解压此版本中的全部内容",
  "extract.desktop": "解压到桌面",
  "extract.desktopTip": "将全部内容解压到桌面上的新文件夹",
  "extract.desktopSelectedTip": "将所选的 {n} 项解压到桌面上的新文件夹",
  "extract.desktopFailed": "无法解压到桌面",
  "extract.folderFailed": "无法检查该文件夹",
  "extract.startFailed": "无法启动",
  "extract.group": "解压到",
  "extract.panelHeading": "解压到此文件夹？",
  "extract.folder": "文件夹",
  "extract.what": "内容",
  "extract.wholeCommit": "版本 {seq} 中的全部内容",
  "extract.entriesCount": "（{count}）",
  "extract.parentsNote": "所选项目上层的文件夹也会一并创建。",
  "extract.folderNote": "请解压到只有您能修改的文件夹中。",
  "extract.caseInsensitive": "此文件夹把仅大小写不同的名称视为同一个名称。",
  "extract.cannotOne": "有 {n} 个项目无法解压到此文件夹：",
  "extract.cannotMany": "有 {n} 个项目无法解压到此文件夹：",
  "extract.cannotList": "无法解压的项目",
  "extract.conflictNote":
    "不会覆盖任何内容，也不会更改任何名称。如果跳过某个文件夹，其中的所有内容也会被跳过。",
  "extract.notOffered":
    "暂不支持替换已有项目，或改用新名称同时保留两者。若要两者都保留，请解压到另一个文件夹或新文件夹。",
  "extract.noConflicts":
    "此文件夹中没有与待解压项目冲突的内容。无论如何都不会覆盖任何内容。",
  "extract.confirmSkip": "跳过这些，解压其余项目",
  "extract.confirm": "解压",
  "extract.changeFolder": "更改文件夹…",
  "extract.newFolderNote":
    "已在压缩文件旁为此新建了一个文件夹，因此您电脑上已有的内容不会被替换。",
  "extract.recheck": "重新检查",
  "extract.checkNote":
    "每个解压出的文件在保留之前，都已对照压缩文件中记录的哈希进行检查。解压不等于测试压缩文件：压缩文件的其他部分没有被检查。",
  "extract.cancelled": "已取消。解压在完成之前停止。",
  "extract.cancelledNote1":
    "取消之前已解压的文件仍留在文件夹中，每个都是完整的。正在写入的文件已被丢弃。",
  "extract.cancelledNote2":
    "已创建的文件夹可能还没有应用记录的时间和权限：这些会在最后设置。",
  "extract.nothingWritten": "没有写入任何内容。",
  "extract.mayHaveExtracted": "部分文件可能已经解压到该文件夹中。",
  "extract.line": "已解压 {parts}",
  "extract.lineNotExtractedOne": "{n} 个项目未解压",
  "extract.lineNotExtractedMany": "{n} 个项目未解压",
  "extract.rowFolder": "文件夹",
  "extract.rowVersion": "来自版本",
  "extract.rowFiles": "文件",
  "extract.rowFolders": "文件夹",
  "extract.rowSize": "大小",
  "extract.rowFolderEntries": "磁盘上的文件夹项目",
  "extract.notConfirmed": "未确认",
  "extract.degradedMark": "DEGRADED",
  "extract.rowNotExtracted": "未解压",
  "extract.rowAttributes": "时间和权限",
  "extract.attributesNotApplied": "未应用",
  "extract.rowAttributeNotes": "未应用的属性",
  "extract.attributesUnavailable":
    "没有应用任何时间、权限或其他属性：无法从压缩文件中读取它们（{reason}）。",
  "extract.attributeLine": "未应用：{attribute}，共 {count} 项。第一项：{path}{escaped}。{reason}",
  "extract.progressRestoreOf": "正在解压：{completed} / {total} 个项目",
  "extract.progressRestore": "正在解压：{completed} 个项目",
  "extract.progressPhaseOf": "{phase}：{completed} / {total}",
  "extract.progressPhase": "{phase}：{completed}",
} satisfies Catalogue<typeof enExtract>;
