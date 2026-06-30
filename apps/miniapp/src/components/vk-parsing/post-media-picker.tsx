import { Camera, Link as IconoirLink } from 'iconoir-react';
import { cn } from '../../lib/cn';
import { PostVideoChoice } from './post-video-preview';

type PostMediaPickerProps = {
  photoUrls: string[];
  videoUrls: string[];
  linkUrls: string[];
  selectedPhotoUrls: string[];
  selectedVideoUrls: string[];
  selectedLinkUrls: string[];
  stripLinksEnabled: boolean;
  disabled: boolean;
  onTogglePhoto: (url: string) => void;
  onToggleVideo: (url: string) => void;
  onToggleLink: (url: string) => void;
};

export function PostMediaPicker({
  photoUrls,
  videoUrls,
  linkUrls,
  selectedPhotoUrls,
  selectedVideoUrls,
  selectedLinkUrls,
  stripLinksEnabled,
  disabled,
  onTogglePhoto,
  onToggleVideo,
  onToggleLink,
}: PostMediaPickerProps) {
  return (
    <>
      {photoUrls.length > 0 ? (
        <div className="vk-parsing-editor__media">
          {photoUrls.map((url, index) => {
            const checked = selectedPhotoUrls.includes(url);
            return (
              <button
                type="button"
                key={url}
                className={cn('vk-parsing-photo-choice', checked && 'is-selected')}
                aria-pressed={checked}
                aria-label={`${checked ? 'Убрать' : 'Вернуть'} фото ${index + 1}`}
                title={checked ? 'Убрать фото' : 'Вернуть фото'}
                disabled={disabled}
                onClick={() => onTogglePhoto(url)}
              >
                <img src={url} alt="" loading="lazy" />
                <Camera aria-hidden />
              </button>
            );
          })}
        </div>
      ) : null}

      {videoUrls.length > 0 ? (
        <div className="vk-parsing-editor__videos">
          {videoUrls.map((url, index) => {
            const checked = selectedVideoUrls.includes(url);
            return (
              <PostVideoChoice
                key={url}
                url={url}
                index={index}
                checked={checked}
                disabled={disabled}
                onToggle={onToggleVideo}
              />
            );
          })}
        </div>
      ) : null}

      {linkUrls.length > 0 && !stripLinksEnabled ? (
        <div className="vk-parsing-editor__links">
          {linkUrls.map((url) => {
            const checked = selectedLinkUrls.includes(url);
            return (
              <label key={url} className="vk-parsing-link-choice">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => onToggleLink(url)}
                />
                <IconoirLink aria-hidden />
                <span>{url}</span>
              </label>
            );
          })}
        </div>
      ) : null}
    </>
  );
}
