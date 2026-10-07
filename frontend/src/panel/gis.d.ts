// Tipos mínimos de Google Identity Services (https://accounts.google.com/gsi/client)
// que usa el panel. Declarados a mano para no agregar dependencias: solo
// initialize, renderButton y disableAutoSelect. Sin One Tap, prompt ni revoke.
export {}

declare global {
  interface GisCredentialResponse {
    credential?: string
    select_by?: string
  }

  interface GisIdConfiguration {
    client_id: string
    callback: (respuesta: GisCredentialResponse) => void
    auto_select?: boolean
    ux_mode?: 'popup'
  }

  interface GisButtonConfiguration {
    type?: 'standard' | 'icon'
    theme?: 'outline' | 'filled_blue' | 'filled_black'
    size?: 'large' | 'medium' | 'small'
    text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin'
    shape?: 'rectangular' | 'pill' | 'circle' | 'square'
    logo_alignment?: 'left' | 'center'
    width?: number
    locale?: string
  }

  interface GisAccountsId {
    initialize(configuracion: GisIdConfiguration): void
    renderButton(contenedor: HTMLElement, opciones: GisButtonConfiguration): void
    disableAutoSelect(): void
  }

  interface Window {
    google?: { accounts?: { id?: GisAccountsId } }
  }
}
