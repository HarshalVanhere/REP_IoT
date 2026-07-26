import { useCallback, useState } from 'react';

/**
 * Tracks which login-form field (if any) should currently be driving the on-screen keyboard.
 * Deliberately knows nothing about the keyboard's own shift/caps UI state or about auth - it
 * only tracks "which field is active", so LoginScreen and VirtualKeyboard both stay simple.
 */
export function useVirtualKeyboard() {
  const [activeInput, setActiveInput] = useState(null); // 'loginId' | 'password' | null

  const open = useCallback((inputName) => setActiveInput(inputName), []);
  const close = useCallback(() => setActiveInput(null), []);

  return { activeInput, isOpen: activeInput !== null, open, close };
}
