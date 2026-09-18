import { useEffect, useRef, useState } from 'react';

export function VkSettingSwitch({
  label,
  checked,
  disabled,
  onChange,
  className = 'vk-setting-row',
  id,
  title,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => Promise<boolean>;
  className?: string;
  id?: string;
  title?: string;
}) {
  const [value, setValue] = useState(checked);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const server = useRef(checked);
  server.current = checked;
  useEffect(() => {
    if (!pending.current) setValue(checked);
  }, [checked, saving]);
  async function change(next: boolean) {
    if (disabled || pending.current) return;
    pending.current = true;
    setSaving(true);
    setValue(next);
    try {
      if (!(await onChange(next))) setValue(server.current);
    } catch {
      setValue(server.current);
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }
  return (
    <label className={className} title={title}>
      <span>{label}</span>
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={value}
        disabled={disabled || saving}
        aria-busy={saving || undefined}
        onChange={(event) => void change(event.target.checked)}
      />
    </label>
  );
}
