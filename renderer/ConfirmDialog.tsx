import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";

type ConfirmDialogProps = {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly isConfirmDisabled?: boolean;
  readonly tone?: "danger" | "primary";
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
  readonly children?: ReactNode;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
};

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function getFocusable(container: HTMLElement): readonly HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((element) => element.getAttribute("aria-hidden") !== "true");
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  isPending,
  error,
  isConfirmDisabled = false,
  tone = "danger",
  initialFocusRef,
  children,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const messageId = useId();

  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const target = initialFocusRef?.current ?? cancelRef.current;
    target?.focus();

    return () => {
      if (previous !== null && previous.isConnected) {
        previous.focus();
      }
    };
  }, [initialFocusRef]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        if (!isPending) {
          onCancel();
        }
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const container = dialogRef.current;

      if (container === null) {
        return;
      }

      const focusable = getFocusable(container);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (first === undefined || last === undefined) {
        event.preventDefault();
        container.focus();
        return;
      }

      const active = document.activeElement;

      if (event.shiftKey) {
        if (active === first || !container.contains(active)) {
          event.preventDefault();
          last.focus();
        }
        return;
      }

      if (active === last || !container.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isPending, onCancel]);

  return (
    <div className="dialog-backdrop">
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        tabIndex={-1}
      >
        <h2 className="dialog-heading" id={titleId}>
          {title}
        </h2>
        <p className="dialog-message" id={messageId}>
          {message}
        </p>
        {children}
        {error === null ? null : (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button
            ref={cancelRef}
            className="button"
            type="button"
            onClick={onCancel}
            disabled={isPending}
          >
            {cancelLabel}
          </button>
          <button
            className={
              tone === "primary"
                ? "button button-primary"
                : "button button-danger"
            }
            type="button"
            onClick={onConfirm}
            disabled={isPending || isConfirmDisabled}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
