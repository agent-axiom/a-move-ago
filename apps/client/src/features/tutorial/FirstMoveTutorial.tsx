import type { Square } from "@a-move-ago/api-contract";
import { parseFen } from "@a-move-ago/game-core";
import { useEffect, useId, useRef, useState } from "react";
import type { Locale } from "../../i18n";
import { tutorialCopy } from "../../i18n/messages/tutorial";
import { Chessboard } from "../game/ui/Chessboard";
import { completeTutorial, dismissTutorialInvitation } from "./tutorial-preference";
import "./tutorial.css";

// A public, fixed teaching example. It has no puzzle, session or rating identifier.
const practiceBoard = parseFen("4k3/8/8/8/4P3/8/8/4K3 b - - 0 1").board;
const previousBoard = parseFen("4k3/8/8/8/8/8/4P3/4K3 w - - 0 1").board;

type Feedback = "selectPawn" | "chooseEmpty" | "tryAgain" | null;

export function FirstMoveTutorial({ locale, onClose }: { locale: Locale; onClose(): void }) {
  const copy = tutorialCopy[locale];
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const successRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const introductionId = useId();
  const [selected, setSelected] = useState(false);
  const [destination, setDestination] = useState<Square | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [solved, setSolved] = useState(false);
  const step = selected ? (destination ? 3 : 2) : 1;
  const instruction = feedback
    ? copy[feedback]
    : step === 1
      ? copy.selectPawn
      : step === 2
        ? copy.selectSquare
        : copy.ready;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement;
    dialog.showModal();
    headingRef.current?.focus();
    return () => {
      dialog.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus();
      }
    };
  }, []);

  useEffect(() => {
    if (solved) successRef.current?.focus();
  }, [solved]);

  function close() {
    dismissTutorialInvitation();
    onClose();
  }

  function reset() {
    setSelected(false);
    setDestination(null);
    setFeedback(null);
    setSolved(false);
    headingRef.current?.focus();
  }

  function select(square: Square) {
    if (solved) return;
    setFeedback(null);
    if (square === "e4") {
      setSelected(true);
      setDestination(null);
    } else if (!selected) {
      setFeedback("selectPawn");
    } else if (practiceBoard[square]) {
      setFeedback("chooseEmpty");
    } else {
      setDestination(square);
    }
  }

  function check() {
    if (!selected || !destination) return;
    if (destination !== "e2") {
      setFeedback("tryAgain");
      return;
    }
    setFeedback(null);
    setSolved(true);
    completeTutorial();
  }

  return (
    <dialog
      aria-describedby={introductionId}
      aria-labelledby={titleId}
      className="tutorial-dialog"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      ref={dialogRef}
    >
      <header className="tutorial-header">
        <div>
          <p className="eyebrow">{copy.eyebrow}</p>
          <h2 id={titleId} ref={headingRef} tabIndex={-1}>
            {copy.title}
          </h2>
        </div>
        <button
          aria-label={copy.close}
          className="button-quiet tutorial-close"
          onClick={close}
          type="button"
        >
          <span aria-hidden="true">×</span>
        </button>
      </header>
      <p className="tutorial-introduction" id={introductionId}>
        {copy.introduction}
      </p>
      <div className="tutorial-workspace">
        <div className="tutorial-board">
          <Chessboard
            board={solved ? previousBoard : practiceBoard}
            destinationSquare={solved ? "e2" : destination}
            disabled={solved}
            label={solved ? copy.beforeBoard : copy.board}
            onSelect={select}
            orientation="white"
            selectedSquare={!solved && selected ? "e4" : null}
          />
          {solved ? <p className="tutorial-board-caption">{copy.previousPosition}</p> : null}
        </div>
        <div className="tutorial-controls">
          {solved ? (
            <>
              <div aria-live="polite" className="tutorial-success">
                <span aria-hidden="true" className="tutorial-success-mark">
                  ✓
                </span>
                <h3 ref={successRef} tabIndex={-1}>
                  {copy.successTitle}
                </h3>
                <p>{copy.successBody}</p>
              </div>
              <p className="tutorial-daily-advice">{copy.dailyAdvice}</p>
              <div className="tutorial-actions">
                <button className="button-primary" onClick={close} type="button">
                  {copy.play}
                </button>
                <button className="button-quiet" onClick={reset} type="button">
                  {copy.replay}
                </button>
              </div>
            </>
          ) : (
            <>
              <ol aria-label={copy.steps} className="tutorial-steps">
                {[copy.stepPiece, copy.stepSquare, copy.stepCheck].map((label, index) => (
                  <li aria-current={step === index + 1 ? "step" : undefined} key={label}>
                    <span aria-hidden="true">{index + 1}</span>
                    {label}
                  </li>
                ))}
              </ol>
              <p aria-live="polite" className="tutorial-instruction">
                {instruction}
              </p>
              <p aria-label={copy.selectedMove} className="tutorial-move">
                <span>{selected ? "e4" : "—"}</span>
                <small>{copy.backTo}</small>
                <span>{destination ?? "—"}</span>
              </p>
              <div className="tutorial-actions">
                <button
                  className="button-primary"
                  disabled={!destination}
                  onClick={check}
                  type="button"
                >
                  {copy.check}
                </button>
                <button className="button-quiet" onClick={reset} type="button">
                  {copy.reset}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      <footer className="tutorial-footer">
        <p>{copy.freePractice}</p>
        {!solved ? (
          <button className="button-quiet" onClick={close} type="button">
            {copy.skip}
          </button>
        ) : null}
      </footer>
    </dialog>
  );
}
