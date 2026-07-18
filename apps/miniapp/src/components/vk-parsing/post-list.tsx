import type { VkParsingPost, VkParsingSettings } from '@maxim/contracts';
import { PostCard } from './post-card';

type PostListProps = {
  posts: VkParsingPost[];
  settings: VkParsingSettings;
  channelLinkUrl?: string;
  editingPostId: string | null;
  publishingPostId: string | null;
  retryingPostId: string | null;
  draftText: string;
  draftTextFormat: VkParsingPost['textFormat'];
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

export function PostList({
  posts,
  settings,
  channelLinkUrl,
  editingPostId,
  publishingPostId,
  retryingPostId,
  draftText,
  draftTextFormat,
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
}: PostListProps) {
  if (posts.length === 0) {
    return null;
  }

  return (
    <div className="vk-parsing-post-list">
      {posts.map((post) => (
        <PostCard
          key={post.id}
          post={post}
          settings={settings}
          channelLinkUrl={channelLinkUrl}
          isEditing={editingPostId === post.id}
          isPublishing={publishingPostId === post.id}
          isRetrying={retryingPostId === post.id}
          draftText={draftText}
          draftTextFormat={draftTextFormat}
          selectedPhotoUrls={selectedPhotoUrls}
          selectedVideoUrls={selectedVideoUrls}
          selectedLinkUrls={selectedLinkUrls}
          onStartEditing={onStartEditing}
          onCancelEditing={onCancelEditing}
          onPublishEditingPost={onPublishEditingPost}
          onRetryPost={onRetryPost}
          onDraftTextChange={onDraftTextChange}
          onTogglePhoto={onTogglePhoto}
          onToggleVideo={onToggleVideo}
          onToggleLink={onToggleLink}
        />
      ))}
    </div>
  );
}
