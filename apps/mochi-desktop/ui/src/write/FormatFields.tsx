import { t } from "../i18n";
import type { ArchiveFormat, CompressionPreset } from "../ipc/write";
import { formatLabel, FORMATS, hasLevel } from "./format";

/** The compression levels, in the order shown. */
export const PRESETS: { id: CompressionPreset; label: () => string; hint: () => string }[] = [
  { id: "fast", label: () => t("write.presetFast"), hint: () => t("write.presetFastHint") },
  { id: "balanced", label: () => t("write.presetBalanced"), hint: () => t("write.presetBalancedHint") },
  { id: "smaller", label: () => t("write.presetSmaller"), hint: () => t("write.presetSmallerHint") },
];

export interface FormatSelectProps {
  value: ArchiveFormat;
  onChange: (format: ArchiveFormat) => void;
  disabled?: boolean;
  testId: string;
}

/** The format of a new archive: `.mochi` (the default), ZIP, tar, tar.gz, tar.zst. */
export function FormatSelect({ value, onChange, disabled = false, testId }: FormatSelectProps) {
  return (
    <label>
      {t("write.format")}{" "}
      <select
        data-testid={testId}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const next = FORMATS.find((f) => f === e.target.value);
          if (next) onChange(next);
        }}
      >
        {FORMATS.map((f) => (
          <option key={f} value={f}>
            {formatLabel(f)}
          </option>
        ))}
      </select>
    </label>
  );
}

export interface LevelSelectProps {
  value: CompressionPreset;
  format: ArchiveFormat;
  onChange: (level: CompressionPreset) => void;
  disabled?: boolean;
  testId: string;
  label: string;
}

/** The compression level as a drop-down; plain tar has none and says so. */
export function LevelSelect({ value, format, onChange, disabled = false, testId, label }: LevelSelectProps) {
  const none = !hasLevel(format);
  return (
    <label>
      {label}{" "}
      <select
        data-testid={testId}
        value={value}
        disabled={disabled || none}
        onChange={(e) => {
          const next = PRESETS.find((p) => p.id === e.target.value);
          if (next) onChange(next.id);
        }}
      >
        {PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label()} ({p.hint()})
          </option>
        ))}
      </select>
    </label>
  );
}
