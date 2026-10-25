import type { ChromeInstallerState } from "../shared/chrome-installer";
import { formatMegabytes, formatPercent } from "./browser-format";
import { texts } from "./texts";

export type BrowserAction = "download" | "local" | "clear";

type BrowserStateViewProps = {
  readonly state: ChromeInstallerState;
  readonly isBusy: boolean;
  readonly pendingAction: BrowserAction | null;
  readonly onDownload: () => void;
  readonly onClearLocal: () => void;
};

function BrowserStateView({
  state,
  isBusy,
  pendingAction,
  onDownload,
  onClearLocal,
}: BrowserStateViewProps) {
  switch (state.status) {
    case "absent":
      return (
        <div className="browser-content">
          <p className="browser-status" role="status" aria-live="polite">
            {texts.browser.absent}
          </p>
          <div className="browser-actions">
            <button
              className="browser-button browser-button-primary"
              type="button"
              onClick={onDownload}
              disabled={isBusy}
            >
              {pendingAction === "download"
                ? texts.actions.startingDownload
                : texts.browser.download}
            </button>
          </div>
        </div>
      );
    case "downloading":
      return (
        <div className="browser-content">
          <p className="browser-status" role="status" aria-live="polite">
            {texts.browser.downloading}
          </p>
          <progress
            className="browser-progress"
            max={100}
            value={state.progress.totalBytes === null ? undefined : state.progress.percent ?? undefined}
            aria-label={texts.browser.progressLabel}
          />
          {state.progress.percent !== null || state.progress.totalBytes !== null ? (
            <div className="browser-progress-meta">
              <span>
                {state.progress.percent === null
                  ? null
                  : texts.browser.percent(formatPercent(state.progress.percent))}
              </span>
              <span>
                {state.progress.totalBytes === null
                  ? null
                  : texts.browser.receivedOfTotal(
                      formatMegabytes(state.progress.receivedBytes),
                      formatMegabytes(state.progress.totalBytes),
                    )}
              </span>
            </div>
          ) : null}
        </div>
      );
    case "verifying":
      return (
        <p className="browser-status" role="status" aria-live="polite">
          {texts.browser.verifying}
        </p>
      );
    case "extracting":
      return (
        <p className="browser-status" role="status" aria-live="polite">
          {texts.browser.extracting}
        </p>
      );
    case "error":
      return (
        <div className="browser-content">
          <p className="browser-error" role="alert">
            {state.error.message}
          </p>
          <div className="browser-actions">
            {state.source === "local" ? (
              <button
                className="browser-button"
                type="button"
                onClick={onClearLocal}
                disabled={isBusy}
              >
                {pendingAction === "clear"
                  ? texts.actions.clearingLocal
                  : texts.browser.backToManaged}
              </button>
            ) : (
              <button
                className="browser-button browser-button-primary"
                type="button"
                onClick={onDownload}
                disabled={isBusy}
              >
                {pendingAction === "download"
                  ? texts.actions.startingDownload
                  : texts.browser.retry}
              </button>
            )}
          </div>
        </div>
      );
    case "ready":
      return null;
  }
}

type BrowserSetupPanelProps = {
  readonly state: ChromeInstallerState | null;
  readonly isBusy: boolean;
  readonly pendingAction: BrowserAction | null;
  readonly checkFailed: boolean;
  readonly actionError: string | null;
  readonly localPath: string;
  readonly onLocalPathChange: (value: string) => void;
  readonly onDownload: () => void;
  readonly onUseLocal: () => void;
  readonly onClearLocal: () => void;
};

export function BrowserSetupPanel({
  state,
  isBusy,
  pendingAction,
  checkFailed,
  actionError,
  localPath,
  onLocalPathChange,
  onDownload,
  onUseLocal,
  onClearLocal,
}: BrowserSetupPanelProps) {
  if (state?.status === "ready") {
    return (
      <section className="browser-panel">
        {checkFailed ? (
          <p className="browser-error" role="alert">
            {texts.browser.checkFailed}
          </p>
        ) : null}
        {actionError === null ? null : (
          <p className="browser-error" role="alert">
            {actionError}
          </p>
        )}
        <div className="browser-ready-row">
          <p className="browser-summary" role="status" aria-live="polite">
            {state.source === "local"
              ? texts.browser.readyLocal(state.version)
              : texts.browser.readyManaged(state.version)}
          </p>
          {state.source === "local" ? (
            <button
              className="browser-button"
              type="button"
              onClick={onClearLocal}
              disabled={isBusy}
            >
              {pendingAction === "clear"
                ? texts.actions.clearingLocal
                : texts.browser.backToManaged}
            </button>
          ) : null}
        </div>
      </section>
    );
  }

  const showLocalForm =
    state?.status === "absent" ||
    (state?.status === "error" && state.source !== "local");

  return (
    <section className="browser-panel" aria-labelledby="browser-heading">
      <h2 className="browser-heading" id="browser-heading">
        {texts.browser.heading}
      </h2>
      {checkFailed ? (
        <p className="browser-error" role="alert">
          {texts.browser.checkFailed}
        </p>
      ) : null}
      {actionError === null ? null : (
        <p className="browser-error" role="alert">
          {actionError}
        </p>
      )}
      {state === null ? null : (
        <BrowserStateView
          state={state}
          isBusy={isBusy}
          pendingAction={pendingAction}
          onDownload={onDownload}
          onClearLocal={onClearLocal}
        />
      )}
      {showLocalForm ? (
        <div className="browser-local-form">
          <label className="browser-label" htmlFor="browser-local-path">
            {texts.browser.localLabel}
          </label>
          <input
            id="browser-local-path"
            className="browser-input"
            type="text"
            value={localPath}
            onChange={(event) => onLocalPathChange(event.target.value)}
            placeholder={texts.browser.localPlaceholder}
            autoComplete="off"
            spellCheck={false}
            disabled={isBusy}
          />
          <button
            className="browser-button"
            type="button"
            onClick={onUseLocal}
            disabled={isBusy || localPath.trim() === ""}
          >
            {pendingAction === "local"
              ? texts.actions.checkingLocal
              : texts.browser.useLocal}
          </button>
        </div>
      ) : null}
    </section>
  );
}
