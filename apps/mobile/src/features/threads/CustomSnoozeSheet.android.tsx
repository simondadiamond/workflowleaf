import {
  AlertDialog,
  Column,
  DatePickerDialog,
  DateTimePicker,
  Host,
  OutlinedTextField,
  SegmentedButton,
  SingleChoiceSegmentedButtonRow,
  Text,
  TextButton,
  useNativeState,
} from "@expo/ui/jetpack-compose";
import {
  defaultMinSize,
  fillMaxWidth,
  testID,
  verticalScroll,
} from "@expo/ui/jetpack-compose/modifiers";
import {
  localSnoozeDate,
  localSnoozeTime,
  resolveCustomSnooze,
  type CustomSnoozeInput,
} from "@t3tools/client-runtime/state/thread-settled";
import { useState } from "react";

import { OverlayPortal } from "../../components/OverlayPortal";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import { CustomSnoozeSheet as LegacyCustomSnoozeSheet } from "./CustomSnoozeSheet.shared";
import {
  applySnoozePickerDate,
  applySnoozePickerTime,
  snoozeDateToPickerDate,
} from "./customSnoozeDate";

type Props = Parameters<typeof LegacyCustomSnoozeSheet>[0];

const modes = [
  { value: "date", label: "Date and time" },
  { value: "duration", label: "Duration" },
] as const;
const units = [
  { value: "minutes", label: "Minutes" },
  { value: "hours", label: "Hours" },
  { value: "days", label: "Days" },
] as const;

export function CustomSnoozeSheet(props: Props) {
  const { materialYouStyleLayoutActive } = useAppearancePreferences();
  return materialYouStyleLayoutActive ? (
    <MaterialCustomSnoozeDialog {...props} />
  ) : (
    <LegacyCustomSnoozeSheet {...props} />
  );
}

function MaterialCustomSnoozeDialog(props: Props) {
  const { themeAppearance, themeVariables: colors } = useAppearancePreferences();
  const titleTypography = useScaledTextRole("title");
  const bodyTypography = useScaledTextRole("footnote");
  const inputTypography = useScaledTextRole("body");
  const [mode, setMode] = useState<CustomSnoozeInput["mode"]>("date");
  const [date, setDate] = useState(() => new Date(Date.now() + 3_600_000));
  const [picker, setPicker] = useState<"date" | "time" | null>(null);
  const [pendingTime, setPendingTime] = useState<Date | null>(null);
  const amount = useNativeState("2");
  const [unit, setUnit] = useState<"minutes" | "hours" | "days">("hours");
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const input: CustomSnoozeInput =
      mode === "date"
        ? { mode, date: localSnoozeDate(date), time: localSnoozeTime(date) }
        : { mode, amount: amount.get().replace(",", "."), unit };
    const snoozedUntil = resolveCustomSnooze(input, new Date());
    if (!snoozedUntil) {
      setError(
        mode === "date" ? "Choose a date and time in the future." : "Enter a positive duration.",
      );
      return;
    }
    props.onSnooze(snoozedUntil);
    props.onClose();
  };
  const segmentedColors = {
    activeContainerColor: colors["--color-secondary"],
    activeContentColor: colors["--color-secondary-foreground"],
    inactiveContainerColor: colors["--color-card-alt"],
    inactiveContentColor: colors["--color-foreground"],
    activeBorderColor: colors["--color-border"],
    inactiveBorderColor: colors["--color-border"],
  };
  const pickerColors = {
    containerColor: colors["--color-card-alt"],
    titleContentColor: colors["--color-foreground-secondary"],
    headlineContentColor: colors["--color-foreground"],
    weekdayContentColor: colors["--color-foreground-secondary"],
    subheadContentColor: colors["--color-foreground"],
    navigationContentColor: colors["--color-foreground"],
    yearContentColor: colors["--color-foreground"],
    dayContentColor: colors["--color-foreground"],
    currentYearContentColor: colors["--color-primary"],
    selectedYearContainerColor: colors["--color-primary"],
    selectedYearContentColor: colors["--color-primary-foreground"],
    selectedDayContainerColor: colors["--color-primary"],
    selectedDayContentColor: colors["--color-primary-foreground"],
    todayContentColor: colors["--color-primary"],
    todayDateBorderColor: colors["--color-primary"],
    dividerColor: colors["--color-border"],
    clockDialColor: colors["--color-secondary"],
    clockDialSelectedContentColor: colors["--color-primary-foreground"],
    clockDialUnselectedContentColor: colors["--color-secondary-foreground"],
    selectorColor: colors["--color-primary"],
    periodSelectorSelectedContainerColor: colors["--color-secondary"],
    periodSelectorSelectedContentColor: colors["--color-secondary-foreground"],
    periodSelectorUnselectedContentColor: colors["--color-foreground"],
    timeSelectorSelectedContainerColor: colors["--color-secondary"],
    timeSelectorSelectedContentColor: colors["--color-secondary-foreground"],
    timeSelectorUnselectedContainerColor: colors["--color-card"],
    timeSelectorUnselectedContentColor: colors["--color-foreground"],
  };
  return (
    // Recycled thread rows can detach a zero-sized native dialog host.
    <OverlayPortal>
      <Host colorScheme={themeAppearance} style={{ height: 0, width: 0 }}>
        <AlertDialog
          onDismissRequest={props.onClose}
          tonalElevation={0}
          colors={{
            containerColor: colors["--color-card-alt"],
            titleContentColor: colors["--color-foreground"],
            textContentColor: colors["--color-foreground-secondary"],
          }}
        >
          <AlertDialog.Title>
            <Text style={titleTypography}>Custom snooze</Text>
          </AlertDialog.Title>
          <AlertDialog.Text>
            <Column
              verticalArrangement={{ spacedBy: 16 }}
              modifiers={[fillMaxWidth(), verticalScroll()]}
            >
              <Text style={bodyTypography}>Choose when snoozed threads return to your inbox.</Text>
              <SingleChoiceSegmentedButtonRow modifiers={[fillMaxWidth()]}>
                {modes.map((option) => (
                  <SegmentedButton
                    key={option.value}
                    selected={mode === option.value}
                    colors={segmentedColors}
                    modifiers={[defaultMinSize({ minHeight: 48 })]}
                    onClick={() => {
                      setMode(option.value);
                      setPicker(null);
                      setError(null);
                    }}
                  >
                    <SegmentedButton.Label>
                      <Text style={bodyTypography}>{option.label}</Text>
                    </SegmentedButton.Label>
                  </SegmentedButton>
                ))}
              </SingleChoiceSegmentedButtonRow>
              {mode === "date" ? (
                <>
                  <TextButton
                    colors={{ contentColor: colors["--color-primary"] }}
                    modifiers={[
                      fillMaxWidth(),
                      defaultMinSize({ minHeight: 48 }),
                      testID("snooze-choose-date"),
                    ]}
                    onClick={() => setPicker("date")}
                  >
                    <Text style={inputTypography}>{`Date: ${date.toLocaleDateString()}`}</Text>
                  </TextButton>
                  <TextButton
                    colors={{ contentColor: colors["--color-primary"] }}
                    modifiers={[
                      fillMaxWidth(),
                      defaultMinSize({ minHeight: 48 }),
                      testID("snooze-choose-time"),
                    ]}
                    onClick={() => {
                      setPendingTime(date);
                      setPicker("time");
                    }}
                  >
                    <Text
                      style={inputTypography}
                    >{`Time: ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}</Text>
                  </TextButton>
                </>
              ) : (
                <>
                  <OutlinedTextField
                    value={amount}
                    singleLine
                    isError={Boolean(error)}
                    textStyle={inputTypography}
                    onValueChange={() => setError(null)}
                    keyboardOptions={{ keyboardType: "decimal", imeAction: "done" }}
                    keyboardActions={{ onDone: submit }}
                    modifiers={[fillMaxWidth(), testID("snooze-duration")]}
                    colors={{
                      focusedTextColor: colors["--color-foreground"],
                      unfocusedTextColor: colors["--color-foreground"],
                      focusedIndicatorColor: colors["--color-primary"],
                      unfocusedIndicatorColor: colors["--color-border"],
                      cursorColor: colors["--color-primary"],
                    }}
                  >
                    <OutlinedTextField.Label>
                      <Text style={bodyTypography}>Duration</Text>
                    </OutlinedTextField.Label>
                  </OutlinedTextField>
                  <SingleChoiceSegmentedButtonRow modifiers={[fillMaxWidth()]}>
                    {units.map((option) => (
                      <SegmentedButton
                        key={option.value}
                        selected={unit === option.value}
                        colors={segmentedColors}
                        modifiers={[defaultMinSize({ minHeight: 48 })]}
                        onClick={() => {
                          setUnit(option.value);
                          setError(null);
                        }}
                      >
                        <SegmentedButton.Label>
                          <Text style={bodyTypography}>{option.label}</Text>
                        </SegmentedButton.Label>
                      </SegmentedButton>
                    ))}
                  </SingleChoiceSegmentedButtonRow>
                </>
              )}
              {error ? (
                <Text style={bodyTypography} color={colors["--color-danger-foreground"]}>
                  {error}
                </Text>
              ) : null}
            </Column>
          </AlertDialog.Text>
          <AlertDialog.DismissButton>
            <TextButton
              onClick={props.onClose}
              colors={{ contentColor: colors["--color-primary"] }}
            >
              <Text style={bodyTypography}>Cancel</Text>
            </TextButton>
          </AlertDialog.DismissButton>
          <AlertDialog.ConfirmButton>
            <TextButton onClick={submit} colors={{ contentColor: colors["--color-primary"] }}>
              <Text style={bodyTypography}>Snooze</Text>
            </TextButton>
          </AlertDialog.ConfirmButton>
        </AlertDialog>
        {picker === "date" ? (
          <DatePickerDialog
            initialDate={snoozeDateToPickerDate(date)}
            color={colors["--color-primary"]}
            elementColors={pickerColors}
            onDismissRequest={() => setPicker(null)}
            onDateSelected={(selected) => {
              setDate(applySnoozePickerDate(date, selected));
              setError(null);
              setPicker(null);
            }}
          />
        ) : null}
        {picker === "time" ? (
          <AlertDialog
            onDismissRequest={() => setPicker(null)}
            tonalElevation={0}
            colors={{
              containerColor: colors["--color-card-alt"],
              titleContentColor: colors["--color-foreground"],
            }}
          >
            <AlertDialog.Title>
              <Text style={titleTypography}>Choose time</Text>
            </AlertDialog.Title>
            <AlertDialog.Text>
              <DateTimePicker
                initialDate={date.toISOString()}
                displayedComponents="hourAndMinute"
                elementColors={pickerColors}
                onDateSelected={setPendingTime}
              />
            </AlertDialog.Text>
            <AlertDialog.DismissButton>
              <TextButton
                onClick={() => setPicker(null)}
                colors={{ contentColor: colors["--color-primary"] }}
              >
                <Text style={bodyTypography}>Cancel</Text>
              </TextButton>
            </AlertDialog.DismissButton>
            <AlertDialog.ConfirmButton>
              <TextButton
                colors={{ contentColor: colors["--color-primary"] }}
                onClick={() => {
                  setDate(applySnoozePickerTime(date, pendingTime ?? date));
                  setError(null);
                  setPicker(null);
                }}
              >
                <Text style={bodyTypography}>OK</Text>
              </TextButton>
            </AlertDialog.ConfirmButton>
          </AlertDialog>
        ) : null}
      </Host>
    </OverlayPortal>
  );
}
