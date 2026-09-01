import type { BroadcastLinkButton } from '@maxim/contracts';
import type { PublisherPostImportOmission } from '@maxim/contracts/publisher';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { BroadcastContentComposer } from '../../components/broadcast-content-composer';
import type { BroadcastSystemButtonPreview } from '../../lib/broadcast-system-buttons';
import { PublicationImportButtonsNotice } from './publication-import-buttons-notice';
import { PUBLICATION_TEXT_MAX_LENGTH, type PublicationDraft } from './publication-model';
import { PublicationRetainedMedia } from './publication-retained-media';
import type { PublisherPostImportAssetPreview } from './use-publisher-post-import-asset-previews';
import { PublicationVideoTool } from './publication-video-tool';

type PublicationContentEditorSectionProps = {
  sectionRef: RefObject<HTMLElement | null>;
  draft: PublicationDraft;
  setDraft: Dispatch<SetStateAction<PublicationDraft>>;
  importOmissions: PublisherPostImportOmission[];
  importing: boolean;
  importedAssetPreviews: readonly PublisherPostImportAssetPreview[];
  customButtons: BroadcastLinkButton[];
  systemButtons: BroadcastSystemButtonPreview[];
  customButtonCount: number;
  hasButtonErrors: boolean;
  showButtonsLabel: boolean;
  isBusy: boolean;
  operationBusy: boolean;
  imagesNeedReselection: boolean;
  retainedVideo: boolean;
  videoPreparing: boolean;
  videoNeedsReselection: boolean;
  fieldError: string;
  onDiscardMissingImages: () => void;
  onResolveMissingImages: () => void;
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
  customButtonCount,
  hasButtonErrors,
  showButtonsLabel,
  isBusy,
  operationBusy,
  imagesNeedReselection,
  retainedVideo,
  videoPreparing,
  videoNeedsReselection,
  fieldError,
  onDiscardMissingImages,
  onResolveMissingImages,
  onOpenButtons,
  onVideoFile,
  onImagePreparationChange,
  onFieldError,
  onInfo,
}: PublicationContentEditorSectionProps) {
  return (
    <section
      ref={sectionRef}
      className="publication-editor-section publication-editor-section--content"
    >
      <div className="publication-editor-section__head">
        <strong>Пост</strong>
        <small>
          {draft.text.length}/{PUBLICATION_TEXT_MAX_LENGTH}
        </small>
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
        onClear={() => setDraft((current) => ({ ...current, retainedAssets: [] }))}
      />
      {imagesNeedReselection ? (
        <div className="publications-inline-notice is-warning" role="alert">
          <span>Фото из локального черновика недоступны. Добавьте их снова.</span>
          <button
            type="button"
            disabled={isBusy}
            onClick={() => {
              onDiscardMissingImages();
              onFieldError('');
            }}
          >
            Без фото
          </button>
        </div>
      ) : null}
      <BroadcastContentComposer
        className="publication-content-composer"
        text={draft.text}
        sourceFormat={draft.textFormat}
        maxLength={PUBLICATION_TEXT_MAX_LENGTH}
        images={draft.images}
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
            onFile={onVideoFile}
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
          if (images.length > 0) {
            onResolveMissingImages();
          }
          setDraft((current) => ({
            ...current,
            images,
            retainedAssets: [],
            mediaType: current.mediaType === 'video' ? null : current.mediaType,
            mediaPayload: current.mediaType === 'video' ? null : current.mediaPayload,
            mediaBase64: current.mediaType === 'video' ? '' : current.mediaBase64,
            mediaMimeType: current.mediaType === 'video' ? '' : current.mediaMimeType,
            mediaFileName: current.mediaType === 'video' ? '' : current.mediaFileName,
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
