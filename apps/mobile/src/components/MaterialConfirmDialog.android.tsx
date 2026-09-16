import { useNativeState } from "@expo/ui";
import { AlertDialog, Host, OutlinedTextField, Text, TextButton } from "@expo/ui/jetpack-compose";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { useScaledTextRole } from "../features/settings/appearance/useScaledTextRole";
import type { MaterialConfirmDialogProps } from "./MaterialConfirmDialog";

export function MaterialConfirmDialog(props: MaterialConfirmDialogProps) {
  const { themeAppearance, themeVariables: colors } = useAppearancePreferences();
  const titleTypography = useScaledTextRole("title");
  const bodyTypography = useScaledTextRole("footnote");
  const inputTypography = useScaledTextRole("body");
  const inputState = useNativeState(props.inputInitialValue ?? "");
  const confirm = () =>
    props.onConfirm(props.inputInitialValue === undefined ? undefined : inputState.get());
  return (
    <Host
      colorScheme={themeAppearance}
      ignoreSafeAreaKeyboardInsets
      style={{ height: 0, width: 0 }}
    >
      <AlertDialog
        onDismissRequest={props.onCancel}
        tonalElevation={0}
        colors={{
          containerColor: colors["--color-card-alt"],
          titleContentColor: colors["--color-foreground"],
          textContentColor: colors["--color-foreground-secondary"],
        }}
      >
        <AlertDialog.Title>
          <Text style={titleTypography}>{props.request.title}</Text>
        </AlertDialog.Title>
        {props.inputInitialValue !== undefined ? (
          <AlertDialog.Text>
            <OutlinedTextField
              autoFocus
              singleLine
              value={inputState}
              onValueChange={props.onInputChange}
              textStyle={inputTypography}
              keyboardOptions={{ imeAction: "done" }}
              keyboardActions={{
                onDone: (value) => {
                  if (value.trim()) props.onConfirm(value);
                },
              }}
              colors={{
                focusedTextColor: colors["--color-foreground"],
                unfocusedTextColor: colors["--color-foreground"],
                focusedIndicatorColor: colors["--color-primary"],
                unfocusedIndicatorColor: colors["--color-border"],
                cursorColor: colors["--color-primary"],
              }}
            />
          </AlertDialog.Text>
        ) : props.request.message ? (
          <AlertDialog.Text>
            <Text style={bodyTypography}>{props.request.message}</Text>
          </AlertDialog.Text>
        ) : null}
        <AlertDialog.DismissButton>
          <TextButton onClick={props.onCancel} colors={{ contentColor: colors["--color-primary"] }}>
            <Text style={bodyTypography}>{props.request.cancelText ?? "Cancel"}</Text>
          </TextButton>
        </AlertDialog.DismissButton>
        <AlertDialog.ConfirmButton>
          <TextButton
            onClick={confirm}
            enabled={!props.confirmDisabled}
            colors={{
              contentColor:
                colors[props.request.destructive ? "--color-danger-foreground" : "--color-primary"],
            }}
          >
            <Text style={bodyTypography}>{props.request.confirmText}</Text>
          </TextButton>
        </AlertDialog.ConfirmButton>
      </AlertDialog>
    </Host>
  );
}
