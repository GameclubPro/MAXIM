import { SendDiagonal, Xmark } from 'iconoir-react';
import { VK_PARSING_MAX_PUBLISH_TEXT_LENGTH, type VkParsingPost } from '@maxim/contracts';
import { PostMediaPicker } from './post-media-picker';

type PostEditorProps = {
  post: VkParsingPost;
  draftText: string;
  selectedPhotoUrls: string[];
  selectedLinkUrls: string[];
  stripLinksEnabled: boolean;
  isPublishing: boolean;
  onDraftTextChange: (value: string) => void;
  onTogglePhoto: (url: string) => void;
  onToggleLink: (url: string) => void;
  onCancel: () => void;
  onPublish: () => void;
};

export function PostEditor({
  post,
  draftText,
  selectedPhotoUrls,
  selectedLinkUrls,
  stripLinksEnabled,
  isPublishing,
  onDraftTextChange,
  onTogglePhoto,
  onToggleLink,
  onCancel,
  onPublish,
}: PostEditorProps) {
  return (
    <div className="vk-parsing-editor">
      <label className="field vk-parsing-editor__text">
        <span>Текст</span>
        <textarea
          rows={7}
          value={draftText}
          onChange={(event) => onDraftTextChange(event.target.value)}
          disabled={isPublishing}
          maxLength={VK_PARSING_MAX_PUBLISH_TEXT_LENGTH}
        />
      </label>

      <PostMediaPicker
        photoUrls={post.photoUrls}
        linkUrls={post.linkUrls}
        selectedPhotoUrls={selectedPhotoUrls}
        selectedLinkUrls={selectedLinkUrls}
        stripLinksEnabled={stripLinksEnabled}
        disabled={isPublishing}
        onTogglePhoto={onTogglePhoto}
        onToggleLink={onToggleLink}
      />

      <div className="vk-parsing-post-card__actions">
        <button
          type="button"
          className="button button--ghost"
          disabled={isPublishing}
          onClick={onCancel}
        >
          <Xmark aria-hidden />
          Отмена
        </button>
        <button
          type="button"
          className="button button--accent"
          disabled={isPublishing}
          onClick={onPublish}
        >
          <SendDiagonal aria-hidden />
          {isPublishing ? 'Публикуем...' : 'Опубликовать'}
        </button>
      </div>
    </div>
  );
}
