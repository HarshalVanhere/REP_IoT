import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import Keyboard from 'react-simple-keyboard';
import 'react-simple-keyboard/build/css/index.css';
import './VirtualKeyboard.css';

const LAYOUT = {
  default: [
    '1 2 3 4 5 6 7 8 9 0 {bksp}',
    'q w e r t y u i o p',
    '{lock} a s d f g h j k l {enter}',
    '{shift} z x c v b n m - _ {shift}',
    '{space} . @ {hide}'
  ],
  shift: [
    '! @ # $ % ^ & * ( ) {bksp}',
    'Q W E R T Y U I O P',
    '{lock} A S D F G H J K L {enter}',
    '{shift} Z X C V B N M - _ {shift}',
    '{space} . @ {hide}'
  ]
};

const DISPLAY = {
  '{bksp}': '⌫',
  '{enter}': 'Enter ⏎',
  '{shift}': '⇧ Shift',
  '{lock}': '⇪ Caps',
  '{space}': 'Space',
  '{hide}': '⌄ Hide Keyboard'
};

// Duplicate touch+mouse synthetic events (common on capacitive touch panels) must not register
// as two key presses - ignore a repeat of the same button within this window.
const DOUBLE_PRESS_GUARD_MS = 80;

/**
 * Touch-optimized on-screen keyboard for the Operator Login screen. Purely a UI/input-routing
 * layer: it never owns the field values, it only reports key activity upward via onChange/
 * onEnter/onHide, so the caller's existing controlled <input> state stays the single source of
 * truth and physical-keyboard typing keeps working unmodified.
 */
function VirtualKeyboard({ visible, activeInput, values, onChange, onEnter, onHide }) {
  const keyboardRef = useRef(null);
  const lastPressRef = useRef({ button: null, time: 0 });
  const [layoutName, setLayoutName] = useState('default');
  const [capsLock, setCapsLock] = useState(false);

  // Keep simple-keyboard's internal input buffer in sync with the controlled value, so typing
  // on a physical keyboard (or a programmatic clear) never desyncs from what the virtual
  // keyboard thinks the current text is.
  useEffect(() => {
    if (!keyboardRef.current || !activeInput) return;
    const nextValue = values[activeInput] ?? '';
    if (keyboardRef.current.getInput(activeInput) !== nextValue) {
      keyboardRef.current.setInput(nextValue, activeInput);
    }
  }, [values, activeInput]);

  const handleChangeAll = useCallback((inputs) => {
    if (!activeInput) return;
    onChange(activeInput, inputs[activeInput] ?? '');
  }, [activeInput, onChange]);

  const handleKeyPress = useCallback((button) => {
    const now = Date.now();
    if (lastPressRef.current.button === button && now - lastPressRef.current.time < DOUBLE_PRESS_GUARD_MS) {
      return;
    }
    lastPressRef.current = { button, time: now };

    if (button === '{enter}') {
      onEnter();
      return;
    }
    if (button === '{hide}') {
      onHide();
      return;
    }
    if (button === '{shift}') {
      setLayoutName((prev) => (prev === 'default' ? 'shift' : 'default'));
      return;
    }
    if (button === '{lock}') {
      setCapsLock((prev) => {
        const next = !prev;
        setLayoutName(next ? 'shift' : 'default');
        return next;
      });
      return;
    }

    // A momentary Shift (as opposed to Caps Lock) reverts after the next character, matching
    // physical-keyboard expectations.
    if (!capsLock && layoutName === 'shift') {
      setLayoutName('default');
    }
  }, [capsLock, layoutName, onEnter, onHide]);

  const activeToggleButtons = layoutName === 'shift' ? (capsLock ? '{lock}' : '{shift}') : '';

  return (
    <div
      className={`virtual-keyboard-dock ${visible ? 'is-open' : ''}`}
      // Prevent the dock from stealing focus away from the real <input> on tap - keeps caret
      // position and physical-keyboard override working while typing on-screen.
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="virtual-keyboard-inner">
        <Keyboard
          keyboardRef={(instance) => { keyboardRef.current = instance; }}
          layoutName={layoutName}
          layout={LAYOUT}
          display={DISPLAY}
          inputName={activeInput || 'default'}
          onChangeAll={handleChangeAll}
          onKeyPress={handleKeyPress}
          preventMouseDownDefault
          disableCaretPositioning
          theme="hg-theme-default kiosk-keyboard-theme"
          buttonTheme={[
            { class: 'kb-key-wide', buttons: '{bksp} {enter} {shift} {lock} {space} {hide}' },
            ...(activeToggleButtons ? [{ class: 'kb-key-active', buttons: activeToggleButtons }] : [])
          ]}
        />
      </div>
    </div>
  );
}

export default memo(VirtualKeyboard);
