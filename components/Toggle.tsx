"use client";

/** Small on/off switch used across the config panels. */
export default function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="relative inline-block h-[18px] w-[34px] cursor-pointer">
      <input
        type="checkbox"
        className="peer h-0 w-0 opacity-0"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <div className="absolute inset-0 rounded-[9px] border border-bd2 bg-sf3 transition-all peer-checked:border-ga peer-checked:bg-ga" />
      <div className="pointer-events-none absolute left-[3px] top-[3px] h-3 w-3 rounded-full bg-white transition-transform peer-checked:translate-x-4" />
    </label>
  );
}
