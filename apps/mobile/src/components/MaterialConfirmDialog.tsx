import type { ConfirmDialogRequest } from "./ConfirmDialogHost";

export interface MaterialConfirmDialogProps {
  readonly request: ConfirmDialogRequest;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function MaterialConfirmDialog(_props: MaterialConfirmDialogProps) {
  return null;
}
