import type { VkParsingPost, VkParsingSettings } from '@maxim/contracts';
import { PostCard } from './post-card';

type PostListProps = {
  posts: VkParsingPost[];
  settings: VkParsingSettings;
  editingPostId: string | null;
  publishingPostId: string | null;
  retryingPostId: string | null;
  draftText: string;
  selectedPhotoUrls: string[];
  selectedLinkUrls: string[];
  onStartEditing: (post: VkParsingPost) => void;
  onCancelEditing: () => void;
  onPublishEditingPost: () => void;
  onRetryPost: (postId: string) => void;
  onDraftTextChange: (value: string) => void;
  onTogglePhoto: (url: string) => void;
  onToggleLink: (url: string) => void;
};

export function PostList({
  posts,
  settings,
  editingPostId,
  publishingPostId,
  retryingPostId,
  draftText,
  selectedPhotoUrls,
  selectedLinkUrls,
  onStartEditing,
  onCancelEditing,
  onPublishEditingPost,
  onRetryPost,
  onDraftTextChange,
  onTogglePhoto,
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
          isEditing={editingPostId === post.id}
          isPublishing={publishingPostId === post.id}
          isRetrying={retryingPostId === post.id}
          draftText={draftText}
          selectedPhotoUrls={selectedPhotoUrls}
          selectedLinkUrls={selectedLinkUrls}
          onStartEditing={onStartEditing}
          onCancelEditing={onCancelEditing}
          onPublishEditingPost={onPublishEditingPost}
          onRetryPost={onRetryPost}
          onDraftTextChange={onDraftTextChange}
          onTogglePhoto={onTogglePhoto}
          onToggleLink={onToggleLink}
        />
      ))}
    </div>
  );
}
