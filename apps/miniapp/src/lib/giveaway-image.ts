type GiveawayImage = {
  imageEnabled: boolean;
  imageMimeType: string;
  imageBase64: string;
};

export function giveawayImageSource(image: GiveawayImage): string | null {
  const mimeType = image.imageMimeType.trim().toLowerCase();
  if (
    !image.imageEnabled ||
    !image.imageBase64.trim() ||
    !/^image\/(?:jpeg|png|webp|gif|avif)$/.test(mimeType)
  ) {
    return null;
  }
  return `data:${mimeType};base64,${image.imageBase64}`;
}
