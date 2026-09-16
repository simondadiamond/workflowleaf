import { Button, FilledTonalButton, Host, Text, TextButton } from "@expo/ui/jetpack-compose";
import { defaultMinSize, fillMaxWidth } from "@expo/ui/jetpack-compose/modifiers";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { useScaledTextRole } from "../features/settings/appearance/useScaledTextRole";
import type { MaterialButtonProps } from "./MaterialButton";

export function MaterialButton(props: MaterialButtonProps) {
  const { themeAppearance, themeVariables: colors } = useAppearancePreferences();
  const typography = useScaledTextRole("footnote");
  const tone = props.tone ?? "secondary";
  const Component =
    tone === "text" ? TextButton : tone === "secondary" ? FilledTonalButton : Button;
  const containerColor =
    tone === "primary"
      ? colors["--color-primary"]
      : tone === "danger"
        ? colors["--color-danger"]
        : tone === "text"
          ? "#00000000"
          : colors["--color-secondary"];
  const contentColor =
    tone === "primary"
      ? colors["--color-primary-foreground"]
      : tone === "danger"
        ? colors["--color-danger-foreground"]
        : tone === "text"
          ? colors["--color-primary"]
          : colors["--color-secondary-foreground"];
  return (
    <Host
      matchContents={props.fullWidth ? { vertical: true } : true}
      colorScheme={themeAppearance}
      ignoreSafeAreaKeyboardInsets
      style={props.fullWidth ? { width: "100%" } : { alignSelf: "flex-start" }}
    >
      <Component
        enabled={!props.disabled}
        onClick={props.onPress}
        modifiers={[
          defaultMinSize({ minHeight: 48 }),
          ...(props.fullWidth ? [fillMaxWidth()] : []),
        ]}
        colors={{
          containerColor,
          contentColor,
          disabledContainerColor: colors["--color-subtle-strong"],
          disabledContentColor: colors["--color-foreground-muted"],
        }}
      >
        <Text style={{ ...typography, fontWeight: "500" }}>{props.label}</Text>
      </Component>
    </Host>
  );
}
