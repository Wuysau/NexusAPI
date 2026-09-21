'use client'

import styles from '@/components/workspace/workspace.module.css'
import { PageHeader } from '@/components/PageHeader'
import { ModelGrid } from '@/components/ModelGrid'

export default function ModelsPage() {
  return (
    <div className={styles.shell}>
      <PageHeader title="模型广场" description="浏览模型并管理模型配置。" />
      <ModelGrid />
    </div>
  )
}
