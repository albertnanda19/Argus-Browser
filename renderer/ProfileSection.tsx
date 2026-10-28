import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Profile } from "../shared/profile";
import type { ArgusRuntime } from "./api-runtime";
import {
  formatLastUsedAt,
  isAbortError,
  toDisplayError,
} from "./cockpit-state";
import { ConfirmDialog } from "./ConfirmDialog";
import { texts } from "./texts";

const PROFILE_LIST_TIMEOUT_MS = 5000;
const PROFILE_MUTATION_TIMEOUT_MS = 10000;

type ProfileSectionProps = {
  readonly runtime: ArgusRuntime;
  readonly selectedProfileId: string | null;
  readonly onSelect: (profile: Profile) => void;
  readonly onDeleted: (profileId: string) => void;
};

type PendingAction = "create" | "delete" | null;

export function ProfileSection({
  runtime,
  selectedProfileId,
  onSelect,
  onDeleted,
}: ProfileSectionProps) {
  const [profiles, setProfiles] = useState<readonly Profile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [nameInput, setNameInput] = useState("");
  const [pending, setPending] = useState<PendingAction>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Profile | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const isMountedRef = useRef(true);
  const versionRef = useRef(0);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let isActive = true;
    const version = versionRef.current;
    setIsLoading(true);
    setListError(null);

    runtime
      .run(PROFILE_LIST_TIMEOUT_MS, (client) =>
        client.profiles.list({ page_size: 100 }),
      )
      .then((response) => {
        if (isActive && versionRef.current === version) {
          setProfiles(response.data);
        }
      })
      .catch((error: unknown) => {
        if (
          isActive &&
          versionRef.current === version &&
          !isAbortError(error)
        ) {
          setListError(toDisplayError(error));
        }
      })
      .finally(() => {
        if (isActive) {
          setIsLoading(false);
        }
      });

    return () => {
      isActive = false;
    };
  }, [runtime, reloadKey]);

  const handleCreate = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    const name = nameInput.trim();

    if (name === "" || pendingRef.current) {
      return;
    }

    pendingRef.current = true;
    versionRef.current += 1;
    setPending("create");
    setFormError(null);

    try {
      const response = await runtime.run(PROFILE_MUTATION_TIMEOUT_MS, (client) =>
        client.profiles.create({ name }),
      );

      if (!isMountedRef.current) {
        return;
      }

      setProfiles((current) => [...current, response.data]);
      setListError(null);
      setNameInput("");
      onSelect(response.data);
    } catch (error: unknown) {
      if (isMountedRef.current && !isAbortError(error)) {
        setFormError(toDisplayError(error));
      }
    } finally {
      pendingRef.current = false;
      if (isMountedRef.current) {
        setPending(null);
      }
    }
  };

  const handleDelete = async (): Promise<void> => {
    const target = deleteTarget;

    if (target === null || pendingRef.current) {
      return;
    }

    pendingRef.current = true;
    versionRef.current += 1;
    setPending("delete");
    setDeleteError(null);

    try {
      await runtime.run(PROFILE_MUTATION_TIMEOUT_MS, (client) =>
        client.profiles.delete(target.id),
      );

      if (!isMountedRef.current) {
        return;
      }

      setProfiles((current) =>
        current.filter((profile) => profile.id !== target.id),
      );
      setListError(null);
      setDeleteTarget(null);
      onDeleted(target.id);
    } catch (error: unknown) {
      if (isMountedRef.current && !isAbortError(error)) {
        setDeleteError(toDisplayError(error));
      }
    } finally {
      pendingRef.current = false;
      if (isMountedRef.current) {
        setPending(null);
      }
    }
  };

  const openDelete = (profile: Profile): void => {
    setDeleteTarget(profile);
    setDeleteError(null);
  };

  const closeDelete = (): void => {
    if (pendingRef.current) {
      return;
    }

    setDeleteTarget(null);
    setDeleteError(null);
  };

  return (
    <section className="panel" aria-labelledby="profiles-heading">
      <h2 className="panel-heading" id="profiles-heading">
        {texts.profiles.heading}
      </h2>

      {isLoading ? (
        <p className="panel-note" role="status" aria-live="polite">
          {texts.profiles.loading}
        </p>
      ) : null}

      {listError === null ? null : (
        <>
          <p className="form-error" role="alert">
            {listError}
          </p>
          <button
            className="button"
            type="button"
            onClick={() => setReloadKey((key) => key + 1)}
            disabled={pending !== null}
          >
            {texts.profiles.retry}
          </button>
        </>
      )}

      {!isLoading && listError === null && profiles.length === 0 ? (
        <p className="panel-note">{texts.profiles.empty}</p>
      ) : null}

      {profiles.length === 0 ? null : (
        <div
          className="profile-list"
          role="radiogroup"
          aria-labelledby="profiles-heading"
        >
          {profiles.map((profile) => {
            const lastUsedAt = formatLastUsedAt(profile.lastUsedAt);

            return (
              <div
                className="profile-row"
                key={profile.id}
                data-selected={profile.id === selectedProfileId}
              >
                <label className="profile-choice">
                  <input
                    type="radio"
                    name="profile"
                    value={profile.id}
                    checked={profile.id === selectedProfileId}
                    onChange={() => onSelect(profile)}
                    aria-label={texts.profiles.choiceLabel(profile.name)}
                  />
                  <span className="profile-text">
                    <span className="profile-name">{profile.name}</span>
                    <span className="profile-meta">
                      {lastUsedAt === null
                        ? texts.profiles.neverUsed
                        : texts.profiles.lastUsed(lastUsedAt)}
                    </span>
                  </span>
                </label>
                <button
                  className="button button-quiet"
                  type="button"
                  onClick={() => openDelete(profile)}
                  disabled={pending !== null}
                  aria-label={texts.profiles.deleteLabel(profile.name)}
                >
                  {texts.profiles.delete}
                </button>
              </div>
            );
          })}
        </div>
      )}

      <form className="profile-form" onSubmit={(event) => void handleCreate(event)}>
        <label className="field-label" htmlFor="profile-name">
          {texts.profiles.nameLabel}
        </label>
        <input
          id="profile-name"
          className="input"
          type="text"
          value={nameInput}
          maxLength={80}
          onChange={(event) => setNameInput(event.target.value)}
          placeholder={texts.profiles.namePlaceholder}
          autoComplete="off"
          disabled={pending !== null}
        />
        {formError === null ? null : (
          <p className="form-error" role="alert">
            {formError}
          </p>
        )}
        <button
          className="button button-primary"
          type="submit"
          disabled={pending !== null || nameInput.trim() === ""}
        >
          {pending === "create"
            ? texts.profiles.creating
            : texts.profiles.create}
        </button>
      </form>

      {deleteTarget === null ? null : (
        <ConfirmDialog
          title={texts.profiles.deleteTitle}
          message={texts.profiles.deleteWarning(deleteTarget.name)}
          confirmLabel={
            pending === "delete"
              ? texts.profiles.deleting
              : texts.profiles.deleteConfirm
          }
          cancelLabel={texts.profiles.cancel}
          isPending={pending === "delete"}
          error={deleteError}
          onConfirm={() => void handleDelete()}
          onCancel={closeDelete}
        />
      )}
    </section>
  );
}
