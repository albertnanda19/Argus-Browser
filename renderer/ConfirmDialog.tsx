import {
  useEffect,
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
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
  readonly children?: ReactNode;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
};

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  isPending,
  error,
  isConfirmDisabled = false,
  initialFocusRef,
  children,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const target = initialFocusRef?.current ?? cancelRef.current;
    target?.focus();
  }, [initialFocusRef]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !isPending) {
        onCancel();
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
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        aria-describedby="dialog-message"
      >
        <h2 className="dialog-heading" id="dialog-title">
          {title}
        </h2>
        <p className="dialog-message" id="dialog-message">
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
            className="button button-danger"
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
