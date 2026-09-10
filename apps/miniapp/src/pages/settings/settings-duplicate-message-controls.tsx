import type { ChatSettings } from '@maxim/contracts/settings';

export default function SettingsDuplicateMessageControls({
  mode,
  value,
  onChange,
}: {
  mode: 'OFF' | 'OBSERVE' | 'DELETE_ONLY';
  value: ChatSettings['duplicateCompareMode'];
  onChange: (value: ChatSettings['duplicateCompareMode']) => void;
}) {
  return (
    <div className="settings-policy">
      <label className="field">
        <span className="field__label">Сравнение сообщений</span>
        <select
          value={value}
          disabled={mode === 'OFF'}
          onChange={(event) => onChange(event.target.value === 'TEXT' ? 'TEXT' : 'MESSAGE')}
        >
          <option value="MESSAGE">Сообщение целиком</option>
          <option value="TEXT">Текст и подпись</option>
        </select>
      </label>
      <span className="field__hint" role="status">
        {mode === 'DELETE_ONLY'
          ? 'Тестовое подключение: только удаление'
          : mode === 'OBSERVE'
            ? 'Тестовое подключение: наблюдение'
            : 'Расширенная проверка не подключена'}
      </span>
    </div>
  );
}
