import './settings-overview-search.css';

export function SettingsOverviewSearchPlaceholder() {
  return (
    <div
      className="settings-overview-search-wrap"
      aria-hidden="true"
      inert
      style={{ visibility: 'hidden' }}
    >
      <div className="settings-overview-search">
        <span />
        <input type="search" value="" readOnly tabIndex={-1} autoComplete="off" />
      </div>
    </div>
  );
}
