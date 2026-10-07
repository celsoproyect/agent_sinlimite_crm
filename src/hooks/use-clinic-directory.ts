"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  ClinicServiceRow,
  ClinicSettings,
  Professional,
  ProfessionalTimeOff,
  Specialty,
} from "@/types";

export interface ClinicDirectoryState {
  /** False until the first load finishes. */
  loaded: boolean;
  /** False while migration 066 hasn't been run. */
  migrated: boolean;
  /** False while migration 067 hasn't been run (services, time off,
   *  insurance). */
  extended: boolean;
  professionals: Professional[];
  specialties: Specialty[];
  services: ClinicServiceRow[];
  /** Upcoming days off of every doctor. */
  timeOff: ProfessionalTimeOff[];
  settings: ClinicSettings;
  reload: () => Promise<void>;
}

const DEFAULT_SETTINGS: ClinicSettings = { ask_insurance: false, insurers: [] };

/** The clinic module's doctors, specialties, services, days off and
 *  insurance settings (`/api/clinic/directory`). Does nothing while
 *  `enabled` is false (module off). */
export function useClinicDirectory(enabled: boolean): ClinicDirectoryState {
  const [loaded, setLoaded] = useState(false);
  const [migrated, setMigrated] = useState(false);
  const [extended, setExtended] = useState(false);
  const [professionals, setProfessionals] = useState<Professional[]>([]);
  const [specialties, setSpecialties] = useState<Specialty[]>([]);
  const [services, setServices] = useState<ClinicServiceRow[]>([]);
  const [timeOff, setTimeOff] = useState<ProfessionalTimeOff[]>([]);
  const [settings, setSettings] = useState<ClinicSettings>(DEFAULT_SETTINGS);

  const reload = useCallback(async () => {
    if (!enabled) return;
    try {
      const res = await fetch("/api/clinic/directory");
      if (!res.ok) return;
      const json = await res.json();
      setMigrated(!!json.migrated);
      setExtended(!!json.extended);
      setProfessionals((json.professionals ?? []) as Professional[]);
      setSpecialties((json.specialties ?? []) as Specialty[]);
      setServices((json.services ?? []) as ClinicServiceRow[]);
      setTimeOff((json.time_off ?? []) as ProfessionalTimeOff[]);
      setSettings((json.settings ?? DEFAULT_SETTINGS) as ClinicSettings);
    } finally {
      setLoaded(true);
    }
  }, [enabled]);

  useEffect(() => {
    // Fetch-on-mount: the state updates happen after the await.
    void reload();
  }, [reload]);

  return { loaded, migrated, extended, professionals, specialties, services, timeOff, settings, reload };
}
