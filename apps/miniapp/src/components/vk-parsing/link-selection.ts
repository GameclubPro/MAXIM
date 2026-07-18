import type { VkParsingPost } from '@maxim/contracts';

export function resolveVkParsingFallbackLink(post: VkParsingPost): string | null {
  if (post.photoUrls.length > 0 || post.videoUrls.length > 0) {
    return null;
  }
  const hasUnsupportedVideo = post.unsupportedAttachments.some(
    (item) => item.type === 'video' || item.type === 'clip',
  );
  return hasUnsupportedVideo && post.linkUrls.includes(post.url) ? post.url : null;
}

export function resolveVkParsingInitialLinkSelection(
  post: VkParsingPost,
  stripLinksEnabled: boolean,
): string[] {
  if (!stripLinksEnabled) {
    return post.linkUrls;
  }
  const fallbackLink = resolveVkParsingFallbackLink(post);
  return fallbackLink ? [fallbackLink] : [];
}
