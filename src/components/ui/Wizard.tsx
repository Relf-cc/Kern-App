/**
 * @Author Christian Relf
 * @Date 2026-10-23
 */

// A multistep modal: the steps along the top, the current step's body, and a
// footer that always reads Back · why-not · secondary · primary. Each flow
// owns its own state and decides what Continue does; this only lays it out
// the same way every time, so a person learns it once.
//
// Steps already passed can be clicked to go back to; steps ahead can't, so a
// flow never has to cope with arriving at step three without step two.

import { useEffect, useRef, type ReactNode } from "react";
import { ArrowLeft, Check, LoaderCircle, type LucideIcon } from "lucide-react";
import { Dialog } from "./Dialog";
import { Button } from "./Button";
import { announce } from "@/lib/announce";

export interface WizardStep<S extends string> {
  id: S;
  label: string;
}

export interface WizardPrimary {
  label: string;
  icon?: LucideIcon;
  /** Defaults to moving to the next step. */
  onClick?: () => void | Promise<void>;
  disabled?: boolean;
  danger?: boolean;
  /** Steps down to a plain button while the step's own decision is on screen. */
  quiet?: boolean;
}

export function Wizard<S extends string>({
  title,
  icon: Icon,
  steps,
  step,
  onStep,
  onClose,
  children,
  blocking,
  primary,
  secondary,
  busy,
  canBack = true,
  wide,
}: {
  title: ReactNode;
  icon?: LucideIcon;
  steps: readonly WizardStep<S>[];
  step: S;
  onStep: (s: S) => void;
  onClose: () => void;
  children: ReactNode;
  /** Why the primary button is disabled, said beside it. */
  blocking?: string | null;
  primary?: WizardPrimary;
  /** Extra footer actions, left of the primary (Skip, Try again). */
  secondary?: ReactNode;
  /** Something is running: Back, close and the stepper are locked. */
  busy?: boolean;
  canBack?: boolean;
  wide?: boolean;
}) {
  const index = Math.max(0, steps.findIndex((s) => s.id === step));
  const next = steps[index + 1];
  const first = useRef(true);

  // The heading doesn't move when the step does, so say where we are.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    announce(`Step ${index + 1} of ${steps.length}: ${steps[index]?.label ?? ""}`);
  }, [index, steps]);

  const go = () => {
    if (primary?.onClick) return void primary.onClick();
    if (next) onStep(next.id);
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      wide={wide}
      className="wizard-dialog"
      hideClose={busy}
      title={
        <span className="row" style={{ gap: 8 }}>
          {Icon && <Icon size={16} strokeWidth={1.75} />}
          {title}
        </span>
      }
      footer={
        <>
          {index > 0 && canBack && (
            <Button variant="ghost" icon={ArrowLeft} disabled={busy} onClick={() => onStep(steps[index - 1].id)}>
              Back
            </Button>
          )}
          <span className="spacer" />
          {blocking && <span className="wizard-dialog__blocking">{blocking}</span>}
          {secondary}
          <Button
            variant={primary?.danger ? "danger" : primary?.quiet ? "default" : "primary"}
            icon={busy ? LoaderCircle : primary?.icon}
            className={busy ? "spin" : undefined}
            disabled={busy || !!blocking || primary?.disabled}
            onClick={go}
          >
            {primary?.label ?? (next ? "Continue" : "Done")}
          </Button>
        </>
      }
    >
      {steps.length > 1 && (
        <ol className="stepper" aria-label="Steps">
          {steps.map((s, i) => {
            const state = i === index ? "current" : i < index ? "done" : "todo";
            return (
              <li key={s.id} className="stepper__item" data-state={state}>
                <button
                  type="button"
                  className="stepper__btn"
                  disabled={i >= index || busy || !canBack}
                  aria-current={i === index ? "step" : undefined}
                  onClick={() => onStep(s.id)}
                >
                  <span className="stepper__dot">{i < index ? <Check size={11} strokeWidth={2.25} /> : i + 1}</span>
                  {s.label}
                </button>
              </li>
            );
          })}
        </ol>
      )}
      <div className="wizard-dialog__body">{children}</div>
    </Dialog>
  );
}
