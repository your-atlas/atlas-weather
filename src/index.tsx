/**
 * Atlas Weather Plugin
 * 
 * Provides weather forecasts for saved locations.
 */

// Plugin types (must match the host app's types)
interface PluginAPI {
  pluginId: string
  permissions: string[]
  hasPermission: (permission: string) => boolean
  storage: {
    get: <T>(key: string) => Promise<T | null>
    set: <T>(key: string, value: T) => Promise<void>
    delete: (key: string) => Promise<void>
    clear: () => Promise<void>
    keys: () => Promise<string[]>
  }
  core: {
    getLocations: () => Promise<Array<{
      id: string
      name: string
      slug: string
      coordinates: { lat: number; lon: number }
      isHome: boolean
    }>>
    getVaultPath: () => Promise<string>
  }
  ui: {
    registerRoute: (route: any) => void
    registerSidebarItem: (item: any) => void
    registerWidget: (widget: any) => void
    registerSettingsPanel: (panel: any) => void
    showToast: (message: string, type?: string) => void
  }
}

interface SharedDependencies {
  React: typeof import('react')
  Button: any
  Card: any
  CardContent: any
  CardHeader: any
  CardTitle: any
  Input: any
  Label: any
  Select: any
  SelectContent: any
  SelectItem: any
  SelectTrigger: any
  SelectValue: any
  Skeleton: any
  useAppData: () => any
  useNavigate: () => any
  useState: typeof import('react').useState
  useEffect: typeof import('react').useEffect
  useCallback: typeof import('react').useCallback
  useMemo: typeof import('react').useMemo
  cn: (...args: any[]) => string
  lucideIcons: Record<string, any>
  useSecondarySidebar?: () => any
}

// Store shared deps globally for components to use
let shared: SharedDependencies
let api: PluginAPI

// ============ WEATHER ICON UTILITIES ============
// Static map for weather icon lookup - avoids recreation on every render
const WEATHER_ICON_MAP: Record<string, string> = {
  '01': 'Sun',
  '02': 'CloudSun',
  '03': 'Cloud',
  '04': 'Cloud',
  '09': 'CloudRain',
  '10': 'CloudRain',
  '11': 'CloudRain',
  '13': 'Cloud',
  '50': 'Cloud',
}

function getWeatherIconKey(iconCode: string | undefined): string {
  if (!iconCode) return 'Cloud'
  const prefix = iconCode.substring(0, 2)
  return WEATHER_ICON_MAP[prefix] || 'Cloud'
}

// ============ WEATHER CACHE UTILITIES ============
interface CachedWeatherData {
  data: any
  timestamp: number
  locationId: string
}

interface WeatherCache {
  [locationId: string]: CachedWeatherData
}

// Module-level cache (survives component remounts within session)
let weatherCache: WeatherCache = {}
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

function getCachedWeather(locationId: string): CachedWeatherData | null {
  const cached = weatherCache[locationId]
  if (!cached) return null

  const isExpired = Date.now() - cached.timestamp > CACHE_TTL_MS
  if (isExpired) {
    delete weatherCache[locationId]
    return null
  }

  return cached
}

function setCachedWeather(locationId: string, data: any): void {
  weatherCache[locationId] = {
    data,
    timestamp: Date.now(),
    locationId,
  }
}

function isCacheStale(locationId: string): boolean {
  const cached = weatherCache[locationId]
  if (!cached) return true
  return Date.now() - cached.timestamp > CACHE_TTL_MS
}

// ============ RATE LIMITING UTILITIES ============
// Debounce utility for preventing rapid API calls
function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null

  return (...args: Parameters<T>) => {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
    timeoutId = setTimeout(() => {
      func(...args)
      timeoutId = null
    }, wait)
  }
}

// Throttle tracking for manual refreshes
let lastRefreshTimestamp: Record<string, number> = {}
const REFRESH_COOLDOWN_MS = 30 * 1000 // 30 seconds

function canRefresh(locationId: string): boolean {
  const lastRefresh = lastRefreshTimestamp[locationId]
  if (!lastRefresh) return true
  return Date.now() - lastRefresh > REFRESH_COOLDOWN_MS
}

function recordRefresh(locationId: string): void {
  lastRefreshTimestamp[locationId] = Date.now()
}

function getRefreshCooldownRemaining(locationId: string): number {
  const lastRefresh = lastRefreshTimestamp[locationId]
  if (!lastRefresh) return 0
  const elapsed = Date.now() - lastRefresh
  return Math.max(0, REFRESH_COOLDOWN_MS - elapsed)
}

// ============ STORAGE KEYS ============
const LAST_LOCATION_KEY = 'lastViewedWeatherLocation'

/**
 * Weather Page Component
 */
function WeatherPage() {
  const { React, Card, CardContent, CardHeader, useAppData, lucideIcons, useSecondarySidebar } = shared
  const { useEffect, useMemo, useState, useCallback, useRef } = React

  const {
    weather,
    weatherLoading,
    weatherError,
    homeLocation,
    savedLocations,
    refreshWeather,
    currentLocation
  } = useAppData()

  // State for stale-while-revalidate pattern
  const [cachedWeatherDisplay, setCachedWeatherDisplay] = useState<any>(null)
  const [isRevalidating, setIsRevalidating] = useState(false)

  // Ref to track debounced refresh
  const debouncedRefreshRef = useRef<ReturnType<typeof debounce> | null>(null)

  // Try to use secondary sidebar if available
  let weatherLocationId = ''
  let setWeatherLocationId = (_id: string) => {}

  if (useSecondarySidebar) {
    const sidebarContext = useSecondarySidebar()
    weatherLocationId = sidebarContext.weatherLocationId || ''
    setWeatherLocationId = sidebarContext.setWeatherLocationId || (() => {})
  }

  // Create debounced refresh function (300ms debounce)
  const debouncedRefresh = useCallback((locationId: string) => {
    if (!debouncedRefreshRef.current) {
      debouncedRefreshRef.current = debounce((locId: string) => {
        // Check throttle before making API call
        if (canRefresh(locId)) {
          recordRefresh(locId)
          setIsRevalidating(true)
          refreshWeather(locId)
        }
      }, 300)
    }
    debouncedRefreshRef.current(locationId)
  }, [refreshWeather])

  // Set initial selected location - with last location memory
  useEffect(() => {
    async function initializeLocation() {
      if (!weatherLocationId) {
        // Try to restore last viewed location
        const lastLocation = await api.storage.get<string>(LAST_LOCATION_KEY)

        if (lastLocation) {
          // Verify the location still exists
          const isValidSaved = savedLocations.some((loc: any) => loc.id === lastLocation)
          const isCurrentLocation = lastLocation === 'current-location' && currentLocation
          const isHome = lastLocation === homeLocation?.id

          if (isValidSaved || isCurrentLocation || isHome) {
            setWeatherLocationId(lastLocation)
            return
          }
        }

        // Fallback to defaults
        if (currentLocation) {
          setWeatherLocationId('current-location')
        } else if (homeLocation) {
          setWeatherLocationId(homeLocation.id)
        }
      }
    }
    initializeLocation()
  }, [currentLocation, homeLocation, weatherLocationId, savedLocations])

  // Save location when it changes
  useEffect(() => {
    if (weatherLocationId) {
      api.storage.set(LAST_LOCATION_KEY, weatherLocationId)
    }
  }, [weatherLocationId])

  // Stale-while-revalidate: Show cached data immediately, refresh in background
  useEffect(() => {
    const locationId = weatherLocationId ||
      (currentLocation ? 'current-location' : homeLocation?.id) ||
      'default'

    // Check cache first for instant display
    const cached = getCachedWeather(locationId)

    if (cached) {
      // Show cached data immediately
      setCachedWeatherDisplay(cached.data)

      // Revalidate if cache is stale
      if (isCacheStale(locationId)) {
        debouncedRefresh(locationId)
      }
    } else {
      // No cache - clear display and fetch fresh data
      setCachedWeatherDisplay(null)
      setIsRevalidating(true)

      // Direct refresh for initial load (no debounce)
      if (canRefresh(locationId)) {
        recordRefresh(locationId)
        refreshWeather(locationId === 'default' ? undefined : locationId)
      }
    }
  }, [weatherLocationId, currentLocation, homeLocation?.id, debouncedRefresh, refreshWeather])

  // Update cache when fresh weather data arrives from host app
  useEffect(() => {
    if (weather) {
      const locationId = weatherLocationId ||
        (currentLocation ? 'current-location' : homeLocation?.id) ||
        'default'

      // Store in cache
      setCachedWeather(locationId, weather)
      // Update display
      setCachedWeatherDisplay(weather)
      setIsRevalidating(false)
    }
  }, [weather, weatherLocationId, currentLocation, homeLocation?.id])

  // Determine which weather data to display (cached or fresh)
  const displayWeather = cachedWeatherDisplay || weather

  // Icons
  const { Home, Navigation, Cloud, CloudRain, Sun, CloudSun } = lucideIcons

  // Memoized icon resolver to avoid recreating on every render
  const iconComponents = useMemo(() => ({
    Sun,
    CloudSun,
    Cloud,
    CloudRain,
  }), [Sun, CloudSun, Cloud, CloudRain])

  // Get weather icon using static lookup map
  const getWeatherIcon = (icon: string) => {
    const key = getWeatherIconKey(icon)
    return iconComponents[key as keyof typeof iconComponents] || Cloud
  }

  // Format hour
  const formatHour = (timestamp: number): string => {
    const date = new Date(timestamp * 1000)
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
  }

  // Format day name
  const formatDayName = (timestamp: number): string => {
    const date = new Date(timestamp * 1000)
    const today = new Date()
    const tomorrow = new Date(today)
    tomorrow.setDate(tomorrow.getDate() + 1)

    if (date.toDateString() === today.toDateString()) return 'Today'
    if (date.toDateString() === tomorrow.toDateString()) return 'Tomorrow'
    return date.toLocaleDateString('en-US', { weekday: 'short' })
  }

  // Hourly data - uses displayWeather for stale-while-revalidate
  const hourlyData = useMemo(() => {
    if (!displayWeather?.hourlyForecast) return []
    const now = Date.now() / 1000
    return displayWeather.hourlyForecast.filter((hour: any) => hour.dt >= now).slice(0, 24)
  }, [displayWeather])

  // Daily data - uses displayWeather for stale-while-revalidate
  const dailyData = useMemo(() => {
    if (!displayWeather?.dailyForecast) return []
    return displayWeather.dailyForecast.slice(0, 8)
  }, [displayWeather])

  // Get selected location
  const isCurrentLocationSelected = weatherLocationId === 'current-location'
  const selectedSavedLocation = savedLocations.find((loc: any) => loc.id === weatherLocationId)
  const selectedLocation = isCurrentLocationSelected 
    ? (currentLocation ? { name: currentLocation.name, isHome: false } : null)
    : (selectedSavedLocation || homeLocation)

  if (weatherError && !displayWeather) {
    return (
      <div className="flex-1 min-h-screen bg-background p-8">
        <div className="mx-auto">
          <div className="text-center text-destructive p-8">
            {weatherError}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-screen bg-background p-8">
      <div className="mx-auto space-y-8">
        {/* Header with location info */}
        {displayWeather && selectedLocation && (
          <div className="text-center mb-8">
            <div className="flex items-center justify-center gap-2 mb-2">
              {isCurrentLocationSelected ? (
                <Navigation className="h-5 w-5 text-muted-foreground" />
              ) : (
                selectedLocation.isHome && <Home className="h-5 w-5 text-muted-foreground" />
              )}
              <h2 className="text-3xl font-semibold">
                {isCurrentLocationSelected ? 'Current location' : selectedLocation.name}
              </h2>
              {isRevalidating && (
                <span className="text-xs text-muted-foreground animate-pulse">Updating...</span>
              )}
            </div>
            <div className="text-6xl font-light mb-2">{displayWeather.temperature}°</div>
            <div className="text-xl text-muted-foreground capitalize mb-2">
              {displayWeather.description}
            </div>
            <div className="text-lg text-muted-foreground">
              H:{displayWeather.tempMax}° L:{displayWeather.tempMin}°
            </div>
          </div>
        )}

        {/* Bento Grid Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          {/* Hourly Forecast - Full Width Top Row */}
          <div className="lg:col-span-12">
            <Card className="p-4">
              <CardHeader className="p-0 pb-4">
                <h3 className="text-sm font-medium text-muted-foreground">HOURLY FORECAST</h3>
              </CardHeader>
              <CardContent className="p-0">
                {weatherLoading ? (
                  <div className="flex gap-4 animate-pulse">
                    {Array.from({ length: 12 }).map((_, i) => (
                      <div key={i} className="flex-shrink-0 w-20 h-32 bg-muted rounded-lg" />
                    ))}
                  </div>
                ) : hourlyData.length > 0 ? (
                  <div className="w-full overflow-x-auto pb-4">
                    <div className="flex gap-4 min-w-max">
                      {hourlyData.map((hour: any, index: number) => {
                        const Icon = getWeatherIcon(hour.weather?.[0]?.icon)
                        return (
                          <div key={hour.dt} className="flex-shrink-0 w-20 flex flex-col items-center gap-2">
                            <div className="text-sm text-muted-foreground">
                              {index === 0 ? 'Now' : formatHour(hour.dt)}
                            </div>
                            <Icon className="h-8 w-8" />
                            {hour.pop > 0 && (
                              <div className="text-xs text-blue-400">{Math.round(hour.pop * 100)}%</div>
                            )}
                            <div className="text-lg font-semibold">{Math.round(hour.temp)}°</div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="p-8 text-center text-muted-foreground">
                    No hourly forecast data available
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Daily Forecast - Left Column */}
          <div className="lg:col-span-3">
            <Card className="p-4">
              <CardHeader className="p-0 pb-4">
                <h3 className="text-sm font-medium text-muted-foreground">8-DAY FORECAST</h3>
              </CardHeader>
              <CardContent className="p-0">
                {weatherLoading ? (
                  <div className="space-y-2">
                    {Array.from({ length: 8 }).map((_, i) => (
                      <div key={i} className="h-12 bg-muted rounded-lg animate-pulse" />
                    ))}
                  </div>
                ) : dailyData.length > 0 ? (
                  <div className="space-y-2">
                    {dailyData.map((day: any) => {
                      const Icon = getWeatherIcon(day.weather?.[0]?.icon)
                      return (
                        <div key={day.dt} className="flex items-center justify-between p-3 rounded-lg hover:bg-accent/50 transition-colors">
                          <div className="w-24 text-sm font-medium">{formatDayName(day.dt)}</div>
                          <Icon className="h-6 w-6" />
                          {day.pop > 0 && (
                            <div className="text-xs text-blue-400 w-12 text-right">
                              {Math.round(day.pop * 100)}%
                            </div>
                          )}
                          {day.pop === 0 && <div className="w-12" />}
                          <div className="flex items-center gap-3 text-sm">
                            <span className="font-semibold">{Math.round(day.temp.max)}°</span>
                            <span className="text-muted-foreground">{Math.round(day.temp.min)}°</span>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <div className="p-8 text-center text-muted-foreground">
                    No daily forecast data available
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Weather Widgets - Right Side Grid */}
          <div className="lg:col-span-9 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {/* Wind Widget */}
            {displayWeather && (
              <Card>
                <CardHeader>
                  <h3 className="text-sm font-medium text-muted-foreground">WIND</h3>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    <div className="text-2xl font-semibold">{displayWeather.windSpeed} mph</div>
                    {displayWeather.windGust && (
                      <div className="text-sm text-muted-foreground">Gusts: {displayWeather.windGust} mph</div>
                    )}
                    <div className="text-sm text-muted-foreground">{displayWeather.windDirection}</div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Humidity Widget */}
            {displayWeather && (
              <Card>
                <CardHeader>
                  <h3 className="text-sm font-medium text-muted-foreground">HUMIDITY</h3>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    <div className="text-3xl font-semibold">{displayWeather.humidity}%</div>
                    <div className="text-sm text-muted-foreground">
                      The dew point is {displayWeather.dewPoint}° right now.
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Visibility Widget */}
            {displayWeather && (
              <Card>
                <CardHeader>
                  <h3 className="text-sm font-medium text-muted-foreground">VISIBILITY</h3>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    <div className="text-3xl font-semibold">{displayWeather.visibility}</div>
                    <div className="text-sm text-muted-foreground">
                      {displayWeather.visibility?.includes('10+') ? 'Perfectly clear view' : 'Good visibility'}
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Pressure Widget */}
            {displayWeather && (
              <Card>
                <CardHeader>
                  <h3 className="text-sm font-medium text-muted-foreground">PRESSURE</h3>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    <div className="text-2xl font-semibold">
                      {(displayWeather.pressure * 0.02953).toFixed(2)} inHg
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* UV Index Widget */}
            {displayWeather && (
              <Card>
                <CardHeader>
                  <h3 className="text-sm font-medium text-muted-foreground">UV INDEX</h3>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    <div className="flex items-baseline gap-2">
                      <span className="text-3xl font-semibold">{Math.round(displayWeather.uvi)}</span>
                      <span className="text-sm text-muted-foreground">
                        {displayWeather.uvi <= 2 ? 'Low' : displayWeather.uvi <= 5 ? 'Moderate' : displayWeather.uvi <= 7 ? 'High' : 'Very High'}
                      </span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Sunrise/Sunset Widget */}
            {displayWeather && (
              <Card>
                <CardHeader>
                  <h3 className="text-sm font-medium text-muted-foreground">SUNRISE</h3>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    <div className="text-2xl font-semibold">{displayWeather.sunrise}</div>
                    <div className="text-sm text-muted-foreground">
                      Sunset: {displayWeather.sunset}
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Weather Settings Panel Component
 */
function WeatherSettings() {
  const { React, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } = shared
  const { useState, useEffect } = React

  const [refreshInterval, setRefreshInterval] = useState(30)
  const [temperatureUnit, setTemperatureUnit] = useState<'fahrenheit' | 'celsius'>('fahrenheit')
  const [loading, setLoading] = useState(true)

  // Load settings on mount - parallelize for faster load
  useEffect(() => {
    async function loadSettings() {
      const [interval, unit] = await Promise.all([
        api.storage.get<number>('refreshInterval'),
        api.storage.get<'fahrenheit' | 'celsius'>('temperatureUnit'),
      ])

      if (interval) setRefreshInterval(interval)
      if (unit) setTemperatureUnit(unit)
      setLoading(false)
    }
    loadSettings()
  }, [])

  // Save helper
  const updateSetting = async <T,>(key: string, value: T, setter: (v: T) => void) => {
    setter(value)
    await api.storage.set(key, value)
  }

  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading settings...</div>
  }

  return (
    <div className="space-y-4">
      {/* Refresh Interval */}
      <div className="flex items-center justify-between">
        <Label className="text-sm">Refresh interval</Label>
        <Select
          value={String(refreshInterval)}
          onValueChange={(v: string) => updateSetting('refreshInterval', Number(v), setRefreshInterval)}
        >
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="15">15 minutes</SelectItem>
            <SelectItem value="30">30 minutes</SelectItem>
            <SelectItem value="60">1 hour</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Temperature Unit */}
      <div className="flex items-center justify-between">
        <Label className="text-sm">Temperature unit</Label>
        <Select
          value={temperatureUnit}
          onValueChange={(v: string) => updateSetting('temperatureUnit', v as 'fahrenheit' | 'celsius', setTemperatureUnit)}
        >
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="fahrenheit">Fahrenheit</SelectItem>
            <SelectItem value="celsius">Celsius</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}

/**
 * Plugin activation
 */
export function activate(pluginApi: PluginAPI, sharedDeps: SharedDependencies) {
  api = pluginApi
  shared = sharedDeps
  
  console.log(`[${api.pluginId}] Activating Weather plugin...`)

  // Register sidebar item
  api.ui.registerSidebarItem({
    id: 'weather',
    title: 'Weather',
    icon: 'Cloud',
    route: '/weather',
    order: 30,
  })

  // Register the route
  api.ui.registerRoute({
    path: '/weather',
    component: WeatherPage,
  })

  api.ui.registerSettingsPanel({
    id: 'weather-settings',
    component: WeatherSettings,
    order: 10,
  })

  console.log(`[${api.pluginId}] Weather plugin activated`)
}

/**
 * Plugin deactivation
 */
export function deactivate() {
  console.log(`[${api?.pluginId}] Weather plugin deactivated`)
}
