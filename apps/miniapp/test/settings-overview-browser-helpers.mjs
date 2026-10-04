export async function clickSettingsOverviewEntry(page, title) {
  // FLAG: Wait for the real lazy search, not its inert geometry placeholder,
  // before interacting with the overview. Post-scroll layout must stay stable
  // between pointerdown and pointerup; perform one ordinary click.
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
