import {
  Camera,
  CheckCircle,
  EditPencil,
  Link as IconoirLink,
  OpenNewWindow,
  Play,
  RefreshCircle,
  ShieldCheck,
  WarningCircle,
} from 'iconoir-react';
import type { VkParsingPost, VkParsingSettings } from '@maxim/contracts';
import { cn } from '../../lib/cn';
import { MaxMarkdownPreview } from '../max-markdown-preview';
import {
  formatUnsupportedAttachmentSummary,
  formatVkPostDate,
  formatVkPostIssue,
  formatVkPostStatus,
  formatVkPublishState,
} from './format';
import { PostEditor } from './post-editor';
import { PostVideoPreview } from './post-video-preview';

type PostCardProps = {
  post: VkParsingPost;
  settings: VkParsingSettings;
  isEditing: boolean;
  isPublishing: boolean;
  isRetrying: boolean;
  draftText: string;
  selectedPhotoUrls: string[];
  selectedVideoUrls: string[];
  selectedLinkUrls: string[];
  onStartEditing: (post: VkParsingPost) => void;
  onCancelEditing: () => void;
  onPublishEditingPost: () => void;
  onRetryPost: (postId: string) => void;
  onDraftTextChange: (value: string) => void;
  onTogglePhoto: (url: string) => void;
  onToggleVideo: (url: string) => void;
  onToggleLink: (url: string) => void;
};

function renderStatusIcon(post: VkParsingPost) {
  if (post.status === 'FAILED') {
    return <WarningCircle aria-hidden />;
  }
  if (post.status === 'PUBLISHED') {
    return <CheckCircle aria-hidden />;
  }
  if (post.status === 'SKIPPED') {
    return <ShieldCheck aria-hidden />;
  }
  if (post.status === 'CHANGED_AFTER_PUBLISH') {
    return <RefreshCircle aria-hidden />;
  }

  return null;
}

export function PostCard({
  post,
  settings,
  isEditing,
  isPublishing,
  isRetrying,
  draftText,
  selectedPhotoUrls,
  selectedVideoUrls,
  selectedLinkUrls,
  onStartEditing,
  onCancelEditing,
  onPublishEditingPost,
  onRetryPost,
  onDraftTextChange,
  onTogglePhoto,
  onToggleVideo,
  onToggleLink,
}: PostCardProps) {
  const dateLabel = formatVkPostDate(post.vkPublishedAt);
  const statusLabel = formatVkPostStatus(post);
  const publishState = formatVkPublishState(post);
  const postIssue = formatVkPostIssue(post);
  const photoCount = post.photoUrls.length;
  const videoCount = post.videoUrls.length;
  const linkCount = post.linkUrls.length;
  const unsupportedSummary = formatUnsupportedAttachmentSummary(post);
  const unsupportedVideo =
    videoCount === 0 ? post.unsupportedAttachments.find((item) => item.type === 'video') : null;
  const unsupportedVideoFallbackUrl =
    unsupportedVideo && post.linkUrls.includes(post.url) ? post.url : null;
  const visiblePhotoUrls = post.photoUrls.slice(0, 4);
  const extraPhotoCount = Math.max(0, post.photoUrls.length - visiblePhotoUrls.length);
  const isReviewMode =
    post.sourcePublishMode === 'REVIEW' && (post.status === 'NEW' || post.status === 'FAILED');
  const visibleStatusLabel = isReviewMode ? null : statusLabel;
  const visiblePostIssue = isReviewMode ? null : postIssue;

  return (
    <article
      className={cn(
        'vk-parsing-post-card',
        `vk-parsing-post-card--${post.status.toLowerCase().replace(/_/gu, '-')}`,
        isReviewMode && 'is-review-mode',
        isEditing && 'is-editing',
        publishState && 'has-publish-state',
        visiblePostIssue?.isMediaIssue && 'has-media-issue',
      )}
    >
      <div className="vk-parsing-post-card__head">
        <div className="vk-parsing-post-card__identity">
          <div className="vk-parsing-post-card__source">
            <strong>{post.sourceTitle}</strong>
            <span>{dateLabel || 'VK'}</span>
          </div>
        </div>
        <div className="vk-parsing-post-card__head-actions">
          {visibleStatusLabel ? (
            <span
              className={cn(
                'vk-parsing-status-pill',
                post.status === 'PUBLISHED' && 'is-success',
                post.status === 'FAILED' && 'is-danger',
                post.status === 'SKIPPED' && 'is-muted',
                post.status === 'CHANGED_AFTER_PUBLISH' && 'is-warning',
              )}
            >
              {renderStatusIcon(post)}
              {visibleStatusLabel}
            </span>
          ) : null}
          <a
            className="vk-parsing-post-card__vk-link"
            href={post.url}
            target="_blank"
            rel="noreferrer"
            aria-label="Открыть пост VK"
            title="Открыть пост VK"
          >
            <OpenNewWindow aria-hidden />
          </a>
        </div>
      </div>

      {visiblePostIssue ? (
        <div className="vk-parsing-post-card__issue" role="status">
          <WarningCircle aria-hidden />
          <span>
            <strong>{visiblePostIssue.title}</strong>
            {visiblePostIssue.detail}
          </span>
        </div>
      ) : null}

      {isEditing ? (
        <PostEditor
          post={post}
          draftText={draftText}
          selectedPhotoUrls={selectedPhotoUrls}
          selectedVideoUrls={selectedVideoUrls}
          selectedLinkUrls={selectedLinkUrls}
          stripLinksEnabled={settings.stripLinksEnabled}
          isPublishing={isPublishing}
          onDraftTextChange={onDraftTextChange}
          onTogglePhoto={onTogglePhoto}
          onToggleVideo={onToggleVideo}
          onToggleLink={onToggleLink}
          onCancel={onCancelEditing}
          onPublish={onPublishEditingPost}
          submitLabel={isReviewMode ? 'Сохранить' : 'Опубликовать'}
          pendingLabel={isReviewMode ? 'Сохраняем...' : 'Публикуем...'}
        />
      ) : (
        <>
          <MaxMarkdownPreview
            value={post.text}
            className="vk-parsing-post-card__text max-markdown-preview--clamp-3"
            normalizeWhitespace
            fallback={
              post.photoUrls.length > 0
                ? 'Фото без текста'
                : videoCount > 0
                  ? 'Видео без текста'
                  : 'Без текста'
            }
          />

          {post.photoUrls.length > 0 ? (
            <div
              className={cn(
                'vk-parsing-post-card__photos',
                photoCount === 1 && 'is-single',
                photoCount === 2 && 'is-pair',
              )}
            >
              {visiblePhotoUrls.map((url, index) => (
                <span key={url} className="vk-parsing-post-card__photo">
                  <img src={url} alt="" loading="lazy" />
                  {index === visiblePhotoUrls.length - 1 && extraPhotoCount > 0 ? (
                    <em>+{extraPhotoCount}</em>
                  ) : null}
                </span>
              ))}
            </div>
          ) : null}

          {videoCount > 0 ? <PostVideoPreview url={post.videoUrls[0]} /> : null}

          {unsupportedVideo ? (
            <div
              className={cn(
                'vk-parsing-post-card__unsupported-video',
                unsupportedVideoFallbackUrl && 'has-fallback-link',
              )}
              role="status"
            >
              <span>
                {unsupportedVideoFallbackUrl ? (
                  <IconoirLink aria-hidden />
                ) : (
                  <WarningCircle aria-hidden />
                )}
              </span>
              <strong>
                {unsupportedVideoFallbackUrl
                  ? 'Видео будет опубликовано ссылкой'
                  : 'Видео недоступно'}
              </strong>
              <small>
                {unsupportedVideoFallbackUrl
                  ? 'В публикации останется ссылка на оригинал.'
                  : 'Это видео нельзя перенести автоматически.'}
              </small>
              {unsupportedVideoFallbackUrl ? (
                <a
                  href={unsupportedVideoFallbackUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Открыть VK-клип"
                  title="Открыть VK-клип"
                >
                  <OpenNewWindow aria-hidden />
                </a>
              ) : null}
            </div>
          ) : null}

          {isReviewMode ? (
            <div className="vk-parsing-review-state" role="status">
              <span className="vk-parsing-review-state__icon">
                <ShieldCheck aria-hidden />
              </span>
              <strong>На модерации</strong>
            </div>
          ) : (
            <div className="vk-parsing-post-card__facts">
              {photoCount > 0 ? (
                <span>
                  <Camera aria-hidden />
                  {photoCount}
                </span>
              ) : null}
              {videoCount > 0 ? (
                <span>
                  <Play aria-hidden />
                  {videoCount}
                </span>
              ) : null}
              {linkCount > 0 ? (
                <span>
                  <IconoirLink aria-hidden />
                  {linkCount}
                </span>
              ) : null}
              {post.isAdvertising ? (
                <span
                  className="vk-parsing-status-pill is-warning"
                  title="В посте есть признаки рекламы"
                >
                  <ShieldCheck aria-hidden />
                  Реклама
                </span>
              ) : null}
              {unsupportedSummary ? (
                <span title={unsupportedSummary}>
                  <WarningCircle aria-hidden />
                  {unsupportedSummary}
                </span>
              ) : null}
              {publishState ? (
                <span
                  className={cn(
                    'vk-parsing-status-pill',
                    publishState.tone === 'warning' && 'is-warning',
                    publishState.tone === 'danger' && 'is-danger',
                  )}
                  title={publishState.title}
                >
                  {publishState.tone === 'danger' ? (
                    <WarningCircle aria-hidden />
                  ) : (
                    <RefreshCircle aria-hidden />
                  )}
                  {publishState.label}
                </span>
              ) : null}
            </div>
          )}

          {post.status === 'PUBLISHED' && post.publishedUrl ? (
            <div className="vk-parsing-post-card__actions">
              <a
                className="button button--ghost vk-parsing-action-button"
                href={post.publishedUrl}
                target="_blank"
                rel="noreferrer"
              >
                <OpenNewWindow aria-hidden />
                MAX
              </a>
            </div>
          ) : null}

          {post.status !== 'PUBLISHED' &&
          post.status !== 'SKIPPED' &&
          post.status !== 'UNAVAILABLE' ? (
            <div className="vk-parsing-post-card__actions">
              {post.status === 'FAILED' && !isReviewMode ? (
                <button
                  type="button"
                  className="button button--ghost vk-parsing-action-button"
                  disabled={isRetrying}
                  onClick={() => onRetryPost(post.id)}
                >
                  <RefreshCircle aria-hidden />
                  {isRetrying ? 'В очереди...' : 'Повторить'}
                </button>
              ) : null}
              <button
                type="button"
                className="button button--ghost vk-parsing-action-button vk-parsing-action-button--primary"
                onClick={() => onStartEditing(post)}
              >
                <EditPencil aria-hidden />
                Редактировать
              </button>
            </div>
          ) : null}
        </>
      )}
    </article>
  );
}
