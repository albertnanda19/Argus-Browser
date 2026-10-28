import { useState } from "react";
import {
  ACTIVITY_FILTERS,
  activityFilterLabel,
  activityKindLabel,
  filterActivityEntries,
  formatActivityTime,
  type ActivityEntry,
  type ActivityFilter,
} from "./activity-log-state";
import { texts } from "./texts";

type ActivityLogPanelProps = {
  readonly entries: readonly ActivityEntry[];
};

export function ActivityLogPanel({ entries }: ActivityLogPanelProps) {
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [query, setQuery] = useState("");
  const visibleEntries = filterActivityEntries(entries, filter, query);
  const isEmpty = entries.length === 0;
  const isFilteredEmpty = !isEmpty && visibleEntries.length === 0;

  return (
    <section className="panel activity-panel" aria-labelledby="activity-heading">
      <h2 className="panel-heading" id="activity-heading">
        {texts.activity.heading}
      </h2>

      <div className="activity-filter">
        <label className="field-label" htmlFor="activity-kind-filter">
          {texts.activity.filterLabel}
        </label>
        <select
          id="activity-kind-filter"
          className="input activity-select"
          value={filter}
          onChange={(event) => {
            const next = ACTIVITY_FILTERS.find(
              (item) => item === event.target.value,
            );

            if (next !== undefined) {
              setFilter(next);
            }
          }}
        >
          {ACTIVITY_FILTERS.map((value) => (
            <option key={value} value={value}>
              {activityFilterLabel(value)}
            </option>
          ))}
        </select>
      </div>

      <div className="activity-filter">
        <label className="field-label" htmlFor="activity-search">
          {texts.activity.searchLabel}
        </label>
        <input
          id="activity-search"
          className="input activity-search"
          type="search"
          value={query}
          placeholder={texts.activity.searchPlaceholder}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <p className="activity-count">
        {texts.activity.count(visibleEntries.length)}
      </p>

      {isEmpty ? (
        <p className="panel-note">{texts.activity.empty}</p>
      ) : null}

      {isFilteredEmpty ? (
        <p className="panel-note">{texts.activity.emptyFiltered}</p>
      ) : null}

      {visibleEntries.length === 0 ? null : (
        <ol className="activity-list">
          {visibleEntries.map((entry) => (
            <li className="activity-item" key={entry.id} data-kind={entry.kind}>
              <div className="activity-meta">
                <time className="activity-time" dateTime={entry.at}>
                  {formatActivityTime(entry.at)}
                </time>
                <span className="activity-kind" data-kind={entry.kind}>
                  {activityKindLabel(entry.kind)}
                </span>
                {entry.taskId === undefined ? null : (
                  <span className="activity-task">{entry.taskId}</span>
                )}
              </div>
              <p className="activity-text">{entry.text}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
