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

/**
 * Weather Page Component
 */
function WeatherPage() {
  const { React, Card, CardContent, CardHeader, Skeleton, useAppData, lucideIcons, useSecondarySidebar } = shared
  const { useState, useEffect, useMemo } = React
  
  const { 
    weather, 
    weatherLoading, 
    weatherError, 
    homeLocation, 
    savedLocations, 
    refreshWeather, 
    currentLocation 
  } = useAppData()
  
  // Try to use secondary sidebar if available
  let weatherLocationId = ''
  let setWeatherLocationId = (_id: string) => {}
  
  if (useSecondarySidebar) {
    const sidebarContext = useSecondarySidebar()
    weatherLocationId = sidebarContext.weatherLocationId || ''
    setWeatherLocationId = sidebarContext.setWeatherLocationId || (() => {})
  }

  // Set initial selected location
  useEffect(() => {
    if (!weatherLocationId) {
      if (currentLocation) {
        setWeatherLocationId('current-location')
      } else if (homeLocation) {
        setWeatherLocationId(homeLocation.id)
      }
    }
  }, [currentLocation, homeLocation, weatherLocationId])

  // Refresh weather when location changes
  useEffect(() => {
    if (weatherLocationId) {
      refreshWeather(weatherLocationId)
    } else if (currentLocation) {
      refreshWeather('current-location')
    } else if (homeLocation) {
      refreshWeather(homeLocation.id)
    } else {
      refreshWeather()
    }
  }, [weatherLocationId, currentLocation, homeLocation?.id])

  const handleLocationChange = (locationId: string) => {
    setWeatherLocationId(locationId)
  }

  // Icons
  const { Home, Navigation, Cloud, CloudRain, Sun, CloudSun, Wind, Droplets, Sunrise, Sunset } = lucideIcons

  // Get weather icon
  const getWeatherIcon = (icon: string) => {
    if (icon?.includes('01')) return Sun
    if (icon?.includes('02')) return CloudSun
    if (icon?.includes('03') || icon?.includes('04')) return Cloud
    if (icon?.includes('09') || icon?.includes('10')) return CloudRain
    return Cloud
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

  // Hourly data
  const hourlyData = useMemo(() => {
    if (!weather?.hourlyForecast) return []
    const now = Date.now() / 1000
    return weather.hourlyForecast.filter((hour: any) => hour.dt >= now).slice(0, 24)
  }, [weather])

  // Daily data
  const dailyData = useMemo(() => {
    if (!weather?.dailyForecast) return []
    return weather.dailyForecast.slice(0, 8)
  }, [weather])

  // Get selected location
  const isCurrentLocationSelected = weatherLocationId === 'current-location'
  const selectedSavedLocation = savedLocations.find((loc: any) => loc.id === weatherLocationId)
  const selectedLocation = isCurrentLocationSelected 
    ? (currentLocation ? { name: currentLocation.name, isHome: false } : null)
    : (selectedSavedLocation || homeLocation)

  if (weatherError && !weather) {
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
        {weather && selectedLocation && (
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
            </div>
            <div className="text-6xl font-light mb-2">{weather.temperature}°</div>
            <div className="text-xl text-muted-foreground capitalize mb-2">
              {weather.description}
            </div>
            <div className="text-lg text-muted-foreground">
              H:{weather.tempMax}° L:{weather.tempMin}°
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
            {weather && (
              <Card>
                <CardHeader>
                  <h3 className="text-sm font-medium text-muted-foreground">WIND</h3>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    <div className="text-2xl font-semibold">{weather.windSpeed} mph</div>
                    {weather.windGust && (
                      <div className="text-sm text-muted-foreground">Gusts: {weather.windGust} mph</div>
                    )}
                    <div className="text-sm text-muted-foreground">{weather.windDirection}</div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Humidity Widget */}
            {weather && (
              <Card>
                <CardHeader>
                  <h3 className="text-sm font-medium text-muted-foreground">HUMIDITY</h3>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    <div className="text-3xl font-semibold">{weather.humidity}%</div>
                    <div className="text-sm text-muted-foreground">
                      The dew point is {weather.dewPoint}° right now.
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Visibility Widget */}
            {weather && (
              <Card>
                <CardHeader>
                  <h3 className="text-sm font-medium text-muted-foreground">VISIBILITY</h3>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    <div className="text-3xl font-semibold">{weather.visibility}</div>
                    <div className="text-sm text-muted-foreground">
                      {weather.visibility?.includes('10+') ? 'Perfectly clear view' : 'Good visibility'}
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Pressure Widget */}
            {weather && (
              <Card>
                <CardHeader>
                  <h3 className="text-sm font-medium text-muted-foreground">PRESSURE</h3>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    <div className="text-2xl font-semibold">
                      {(weather.pressure * 0.02953).toFixed(2)} inHg
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* UV Index Widget */}
            {weather && (
              <Card>
                <CardHeader>
                  <h3 className="text-sm font-medium text-muted-foreground">UV INDEX</h3>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    <div className="flex items-baseline gap-2">
                      <span className="text-3xl font-semibold">{Math.round(weather.uvi)}</span>
                      <span className="text-sm text-muted-foreground">
                        {weather.uvi <= 2 ? 'Low' : weather.uvi <= 5 ? 'Moderate' : weather.uvi <= 7 ? 'High' : 'Very High'}
                      </span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Sunrise/Sunset Widget */}
            {weather && (
              <Card>
                <CardHeader>
                  <h3 className="text-sm font-medium text-muted-foreground">SUNRISE</h3>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    <div className="text-2xl font-semibold">{weather.sunrise}</div>
                    <div className="text-sm text-muted-foreground">
                      Sunset: {weather.sunset}
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

  console.log(`[${api.pluginId}] Weather plugin activated`)
}

/**
 * Plugin deactivation
 */
export function deactivate() {
  console.log(`[${api?.pluginId}] Weather plugin deactivated`)
}
