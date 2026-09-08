/**
 * The 1/2/5/10× segmented control. Plain DOM, same as the rest of the HUD —
 * it only ever reads back whatever the player last clicked.
 */
export class SpeedControl {
  private readonly buttons: HTMLButtonElement[];
  private value = 1;

  constructor(container: HTMLElement) {
    this.buttons = Array.from(container.querySelectorAll('button'));
    for (const button of this.buttons) {
      button.addEventListener('click', () => this.select(Number(button.dataset.speed)));
    }
  }

  /** How many simulation steps should run per rendered frame. */
  get speed(): number {
    return this.value;
  }

  private select(speed: number): void {
    if (!Number.isFinite(speed) || speed <= 0) return;
    this.value = speed;
    for (const button of this.buttons) {
      button.classList.toggle('active', Number(button.dataset.speed) === speed);
    }
  }
}
