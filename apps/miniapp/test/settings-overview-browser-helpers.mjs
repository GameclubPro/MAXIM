export async function clickSettingsOverviewEntry(page, title) {
  // FLAG: The lazy search mounts above the tiles with no placeholder. A tile can
  // already be clickable while that insertion is still able to move it between
  // pointerdown and pointerup; wait for the real overview before a single click.
  await page.getByRole('searchbox', { name: 'Найти настройку', exact: true }).waitFor();
  const entry = page.getByRole('button', { name: title, exact: true });
  await entry.scrollIntoViewIfNeeded();
  // Scrolling can also compact the header after the initial stability check.
  await page.evaluate(async () => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    await document.fonts.ready;
    await frame();
    await frame();
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
        .map((animation) => animation.finished.catch(() => {})),
    );
    await frame();
    await frame();
  });
  await entry.click();
}
