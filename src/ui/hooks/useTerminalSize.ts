import { useState, useEffect } from 'react';

export interface TerminalSize {
  width: number;
  height: number;
}

export function useTerminalSize(): TerminalSize {
  const [size, setSize] = useState<TerminalSize>(() => ({
    width: process.stdout.columns || 80,
    height: process.stdout.rows || 24,
  }));

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const onResize = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        setSize({
          width: process.stdout.columns || 80,
          height: process.stdout.rows || 24,
        });
      }, 100);
    };

    process.stdout.on('resize', onResize);
    return () => {
      process.stdout.removeListener('resize', onResize);
      if (timer) clearTimeout(timer);
    };
  }, []);

  return size;
}
