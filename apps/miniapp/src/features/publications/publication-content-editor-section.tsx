import type { BroadcastLinkButton } from '@maxim/contracts';
import { MAX_PUBLICATION_IMAGES } from '@maxim/contracts/publication';
import type { PublisherPostImportOmission } from '@maxim/contracts/publisher';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { BroadcastContentComposer } from '../../components/broadcast-content-composer';
import type { BroadcastSystemButtonPreview } from '../../lib/broadcast-system-buttons';
import { PublicationImportButtonsNotice } from './publication-import-buttons-notice';
import {
  getPublicationTargetKey,
  getPublicationTargetTitle,
  PUBLICATION_TEXT_MAX_LENGTH,
  type PublicationDraft,
  type PublicationTarget,
} from './publication-model';
import { PublicationRetainedMedia } from './publication-retained-media';
import type { PublisherPostImportAssetPreview } from './use-publisher-post-import-asset-previews';
import { PublicationVideoTool } from './publication-video-tool';
import './publication-content-editor-section.css';

type PublicationContentEditorSectionProps = {
  sectionRef: RefObject<HTMLElement | null>;
  draft: PublicationDraft;
  setDraft: Dispatch<SetStateAction<PublicationDraft>>;
  importOmissions: PublisherPostImportOmission[];
  importing: boolean;
  importedAssetPreviews: readonly PublisherPostImportAssetPreview[];
  customButtons: BroadcastLinkButton[];
  systemButtons: BroadcastSystemButtonPreview[];
  previewTargets: readonly PublicationTarget[];
  previewTargetKey: string | null;
  customButtonCount: number;
  hasButtonErrors: boolean;
  showButtonsLabel: boolean;
  isBusy: boolean;
  operationBusy: boolean;
  imagesNeedReselection: boolean;
  missingImageCount: number;
  retainedVideo: boolean;
  videoPreparing: boolean;
  videoNeedsReselection: boolean;
  fieldError: string;
  onDiscardMissingImages: () => void;
  onResolveMissingImages: (currentImageCount: number) => void;
  onPreviewTargetChange: (targetKey: string) => void;
  onOpenButtons: () => void;
  onVideoFile: (file: File | undefined) => Promise<void>;
  onImagePreparationChange: (preparing: boolean) => void;
  onFieldError: (message: string) => void;
  onInfo: (message: string) => void;
};

export function PublicationContentEditorSection({
  sectionRef,
  draft,
  setDraft,
  importOmissions,
  importing,
  importedAssetPreviews,
  customButtons,
  systemButtons,
  previewTargets,
  previewTargetKey,
  customButtonCount,
  hasButtonErrors,
  showButtonsLabel,
  isBusy,
  operationBusy,
  imagesNeedReselection,
  missingImageCount,
  retainedVideo,
  videoPreparing,
  videoNeedsReselection,
  fieldError,
  onDiscardMissingImages,
  onResolveMissingImages,
  onPreviewTargetChange,
  onOpenButtons,
  onVideoFile,
  onImagePreparationChange,
  onFieldError,
  onInfo,
}: PublicationContentEditorSectionProps) {
  const retainedImageCount = draft.retainedAssets.filter((asset) => asset.type === 'image').length;
  const maxLocalImageCount = Math.max(0, MAX_PUBLICATION_IMAGES - retainedImageCount);
  const imageInputAllowed =
    !retainedVideo && draft.mediaType !== 'video' && draft.images.length < maxLocalImageCount;
  const videoBlockedReason =
    missingImageCount > 0
      ? 'Сначала завершите восстановление фото'
      : retainedImageCount > 0 || draft.images.length > 0
        ? 'Сначала удалите фото'
        : null;

  return (
    <section
      ref={sectionRef}
      className="publication-editor-section publication-editor-section--content"
    >
      <div className="publication-editor-section__head">
        <strong>Пост</strong>
        {previewTargets.length > 1 ? (
          <select
            className="publication-editor-section__preview-target"
            value={previewTargetKey ?? ''}
            disabled={isBusy}
            aria-label="Получатель в предпросмотре"
            onChange={(event) => onPreviewTargetChange(event.currentTarget.value)}
          >
            {previewTargets.map((target) => (
              <option key={getPublicationTargetKey(target)} value={getPublicationTargetKey(target)}>
                {getPublicationTargetTitle(target)}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      {draft.timingMode === 'schedule' ? (
        <input
          className="publication-title-input"
          value={draft.title}
          maxLength={120}
          placeholder="Название расписания"
          onChange={(event) =>
            setDraft((current) => ({ ...current, title: event.currentTarget.value }))
          }
          disabled={isBusy}
        />
      ) : null}
      <PublicationImportButtonsNotice
        omissions={importing ? importOmissions : []}
        customButtonCount={customButtonCount}
        disabled={isBusy}
        onAdd={onOpenButtons}
      />
      <PublicationRetainedMedia
        assets={draft.retainedAssets}
        previews={importedAssetPreviews}
        disabled={isBusy}
        onRemove={(assetId) =>
          setDraft((current) => ({
            ...current,
            retainedAssets: current.retainedAssets.filter((asset) => asset.id !== assetId),
          }))
        }
      />
      {imagesNeedReselection ? (
        <div className="publications-inline-notice is-warning" role="alert">
          <span>
            {missingImageCount > 1
              ? `Не удалось восстановить ${missingImageCount} фото. Добавьте их снова.`
              : 'Не удалось восстановить фото. Добавьте его снова.'}
          </span>
          <button
            type="button"
            disabled={isBusy}
            onClick={() => {
              onDiscardMissingImages();
              onFieldError('');
            }}
          >
            {draft.images.length > 0 ? 'Оставить выбранные' : 'Без фото'}
          </button>
        </div>
      ) : null}
      <BroadcastContentComposer
        className="publication-content-composer"
        text={draft.text}
        sourceFormat={draft.textFormat}
        maxLength={PUBLICATION_TEXT_MAX_LENGTH}
        images={draft.images}
        maxImages={Math.max(1, maxLocalImageCount)}
        allowImages={imageInputAllowed}
        buttons={customButtons}
        systemButtons={systemButtons}
        buttonsPerRow={1}
        buttonsStatusLabel="Кнопка"
        buttonsActive={customButtonCount > 0}
        buttonsError={hasButtonErrors}
        showButtonsLabel={showButtonsLabel}
        additionalMediaAction={
          <PublicationVideoTool
            active={draft.mediaType === 'video'}
            disabled={isBusy || videoPreparing}
            preparing={videoPreparing}
            needsReselection={videoNeedsReselection}
            blockedReason={videoBlockedReason}
            onFile={onVideoFile}
            onBlocked={() => videoBlockedReason && onInfo(videoBlockedReason)}
          />
        }
        videoLabel={
          draft.mediaType === 'video'
            ? draft.mediaFileName || 'Видео'
            : retainedVideo
              ? 'Видео'
              : null
        }
        disabled={operationBusy}
        textError={
          fieldError.includes('текст') ||
          fieldError.includes('фото') ||
          fieldError.includes('видео')
            ? fieldError
            : ''
        }
        textPlaceholder="Текст публикации"
        messageAriaLabel="Текст публикации"
        onTextChange={(text) => {
          setDraft((current) => ({ ...current, text, textFormat: 'markdown' }));
          onFieldError('');
        }}
        onImagesChange={(images) => {
          onResolveMissingImages(images.length);
          setDraft((current) => ({
            ...current,
            images,
          }));
          onFieldError('');
        }}
        onImagePreparationChange={onImagePreparationChange}
        onOpenButtons={onOpenButtons}
        onClearVideo={() =>
          setDraft((current) => ({
            ...current,
            retainedAssets: current.retainedAssets.filter((asset) => asset.type !== 'video'),
            mediaType: null,
            mediaPayload: null,
            mediaBase64: '',
            mediaMimeType: '',
            mediaFileName: '',
          }))
        }
        onError={onInfo}
      />
    </section>
  );
}
