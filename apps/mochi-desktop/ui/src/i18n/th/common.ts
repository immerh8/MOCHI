import type { Catalogue } from "../types";
import type { common as enCommon } from "../en/common";
// Thai glossary (use these terms consistently in every th/*.ts file):
//   archive            ไฟล์บีบอัด (short: ไฟล์)      extract          แตกไฟล์
//   test / verify      ทดสอบ / ตรวจสอบ              repair           ซ่อม
//   version (commit)   เวอร์ชัน (commit = คอมมิต)    snapshot         สแนปช็อต
//   entry / item       รายการ                       folder           โฟลเดอร์
//   passphrase         วลีรหัสผ่าน                   password         รหัสผ่าน
//   encrypt            เข้ารหัส                      key envelope     ซองกุญแจ
//   recovery record    ข้อมูลกู้คืน                   salvage scan     สแกนกู้ข้อมูลที่เหลือ
//   health             สภาพ                         retention        ระยะเวลาเก็บ
//   catalog            แค็ตตาล็อก                    hash             แฮช
// Kept in English: error codes, PASS/FAIL/DEGRADED/UNKNOWN/OVERDUE/UNSUPPORTED, LOCAL_COMMITTED,
// format names (.mochi, ZIP, tar, BLAKE3 ...). Never write "backed up / safe / secure / preserved /
// revoked" in Thai (spec 23.3): no ปลอดภัย, สำรองข้อมูล, เก็บรักษาแล้ว, เพิกถอน, ซ่อมแซมแล้ว.
// Wording shared by more than one screen.
export const common = {
  "common.cancel": "ยกเลิก",
  "common.close": "ปิด",
  "common.starting": "กำลังเริ่ม…",
  "common.loading": "กำลังโหลด…",
  "common.cancelling": " (กำลังยกเลิก…)",
  "common.folder": "โฟลเดอร์",
  "common.file": "ไฟล์",
  "common.escapedMarker": " (แสดงแบบหลีก)",
  "common.escapedHint":
    "แสดงแบบหลีกอักขระ: ชื่อที่เก็บไว้มีอักขระควบคุม ตัวกำหนดทิศทาง เครื่องหมายแบ็กสแลช หรือไบต์ที่ไม่ใช่ UTF-8",
  "common.errorWithCode": "{what} ({code}): {message}",
  "common.errorPlain": "{what}",
  "common.completed": "เสร็จสิ้น: {summary}",
  "common.failed": "ไม่สำเร็จ ({code}): {message}",
  "common.stoppedUnexpectedly": "หยุดทำงานโดยไม่คาดคิด: {message}",
  "common.byteOne": "{n} ไบต์",
  "common.bytesMany": "{n} ไบต์",
  "common.sizeWithExact": "{human} ({exact})",
  "common.sizeHuman": "{value} {unit}",
  "common.progress": "ความคืบหน้า",
  "common.itemOne": "{n} รายการ",
  "common.itemMany": "{n} รายการ",
  "common.selectedCount": "เลือกไว้ {n}",
  "common.statusSeparator": " · ",
  "count.fileOne": "{n} ไฟล์",
  "count.fileMany": "{n} ไฟล์",
  "count.folderOne": "{n} โฟลเดอร์",
  "count.folderMany": "{n} โฟลเดอร์",
  "count.entryOne": "{n} รายการ",
  "count.entryMany": "{n} รายการ",
  "count.problemOne": "{n} ปัญหา",
  "count.problemMany": "{n} ปัญหา",
  "common.andMore": "…และอีก {n} รายการ",
} satisfies Catalogue<typeof enCommon>;
