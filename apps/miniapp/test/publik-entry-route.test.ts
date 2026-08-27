import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8');

function sourceBetween(start: string, end: string): string {
  const startIndex = appSource.indexOf(start);
  const endIndex = appSource.indexOf(end, startIndex + start.length);

  assert.ok(startIndex >= 0, `Missing source marker: ${start}`);
  assert.ok(endIndex > startIndex, `Missing source marker: ${end}`);
  return appSource.slice(startIndex, endIndex);
}

test('authenticated /publik entry redirects to the Posts home and preserves search', () => {
  const authenticatedRoutes = sourceBetween('function AppRoutes(', 'function ProfiledAppRoutes(');

  assert.match(
    appSource,
    /function ProfileHomeRedirect\(\{ homeRoute \}: Pick<Me, 'homeRoute'>\)[\s\S]*?`\$\{homeRoute\}\$\{location\.search\}`/u,
  );
  assert.match(
    authenticatedRoutes,
    /path="\/publik" element=\{<ProfileHomeRedirect homeRoute=\{profileHomeRoute\} \/>\}/u,
  );
  assert.doesNotMatch(authenticatedRoutes, /path="\/publik" element=\{<LazyPublikPage \/>\}/u);
  assert.match(
    authenticatedRoutes,
    /const profileHomeRoute = me\.homeRoute;[\s\S]*?moderationProfile[\s\S]*?<Route path="\/" element=\{<LazyChatsPage[\s\S]*?<Route path="\/" element=\{<ProfileHomeRedirect homeRoute=\{profileHomeRoute\} \/>\}/u,
  );
  assert.doesNotMatch(authenticatedRoutes, /LazyPublisherEntitiesPage/u);
});

test('unauthenticated /publik entry cannot bypass the startup auth gate', () => {
  const publicRoutes = sourceBetween('function PublicLegalRoutes()', 'export function App()');

  assert.doesNotMatch(publicRoutes, /path="\/publik"/u);
  assert.doesNotMatch(appSource, /isPublicBotPathnameFromWindow/u);
});
