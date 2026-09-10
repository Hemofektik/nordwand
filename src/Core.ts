export const EGameState = Object.freeze(
    {
        None: 0x00,
        Menu: 0x01,
        Demo: 0x02,
        Game: 0x04,
        Climbing: 0x08,
        Rappelling: 0x10,
    } as const,
);

export type EGameState = (typeof EGameState)[keyof typeof EGameState];
