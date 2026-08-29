import type { PublisherPostImportOmission } from '@maxim/contracts/publisher';
import { Link as LinkIcon } from 'iconoir-react';
import { shouldOfferPublisherButtonRecovery } from './publisher-post-import-model';
import './publication-import-buttons-notice.css';

type PublicationImportButtonsNoticeProps = {
  omissions: PublisherPostImportOmission[];
  customButtonCount: number;
  disabled: boolean;
  onAdd: () => void;
};

export function PublicationImportButtonsNotice({
  omissions,
  customButtonCount,
  disabled,
  onAdd,
}: PublicationImportButtonsNoticeProps) {
  if (!shouldOfferPublisherButtonRecovery(omissions, customButtonCount)) {
    return null;
  }

  return (
    <div className="publication-import-buttons-notice" role="status">
      <LinkIcon aria-hidden />
      <span>Кнопки не перенесены</span>
      <button type="button" onClick={onAdd} disabled={disabled}>
        Добавить
      </button>
    </div>
  );
}
