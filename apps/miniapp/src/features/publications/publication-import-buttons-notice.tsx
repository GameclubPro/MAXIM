import { AppIcon as IconoirSprite } from '../../components/ui/app-icon';
import type { PublisherPostImportOmission } from '@maxim/contracts/publisher';

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
      <IconoirSprite variant="iconoir" icon="Link" aria-hidden />
      <span>Кнопки не перенесены</span>
      <button type="button" onClick={onAdd} disabled={disabled}>
        Добавить
      </button>
    </div>
  );
}
