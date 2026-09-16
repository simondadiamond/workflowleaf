import { Platform, Switch, type SwitchProps } from "react-native";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { MaterialSwitch } from "./MaterialSwitch";

export type ThemedSwitchProps = Pick<
  SwitchProps,
  | "accessibilityHint"
  | "accessibilityLabel"
  | "disabled"
  | "onValueChange"
  | "style"
  | "testID"
  | "value"
>;

export function ThemedSwitch(props: ThemedSwitchProps) {
  const { materialYouStyleLayoutActive } = useAppearancePreferences();
  if (materialYouStyleLayoutActive) {
    return <MaterialSwitch {...props} />;
  }

  return (
    <Switch
      {...props}
      ios_backgroundColorClassName="accent-switch-inactive-track"
      thumbColorClassName={
        Platform.OS === "android"
          ? props.value
            ? "accent-switch-active-thumb"
            : "accent-switch-inactive-thumb"
          : undefined
      }
      trackColorOffClassName="accent-switch-inactive-track"
      trackColorOnClassName="accent-switch-active-track"
    />
  );
}
